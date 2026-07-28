import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { keymaxxerEnvironment, keymaxxerMcpCommand } from "./mcp-layer.js"

export const KEYMAXXER_SIDECAR_URL_PREFIX = "KEYMAXXER_SIDECAR_URL="

/** Max unlock probe attempts for wrong-passphrase failures (inclusive). */
export const MAX_UNLOCK_ATTEMPTS = 3

/**
 * Keymaxxer 0.2.x returns `error: wrong passphrase.` as tool text (no structured
 * code). Treat this as a safe pre-operation unlock failure that may be retried.
 */
export const isWrongPassphraseResult = (result: {
  readonly isError?: boolean
  readonly content?: unknown
}): boolean => {
  if (result.isError !== true) return false
  return /error:\s*wrong passphrase\.?/i.test(toolResultText(result))
}

export const TOOL_NAMES = [
  "keymaxxer_list",
  "keymaxxer_run",
  "keymaxxer_add",
] as const

export type FacadeHandle = {
  readonly url: string
  readonly port: number
  readonly hostname: string
  readonly stop: () => Promise<void>
}

export type StartFacadeOptions = {
  readonly port?: number
  readonly host?: string
  readonly environment?: Partial<Record<string, string | undefined>>
  readonly keymaxxerCommand?: { command: string; args: string[] }
  readonly createUpstream?: () => Promise<KeymaxxerUpstreamClient>
  readonly onBootstrapUrl?: (url: string) => void
  readonly log?: (message: string) => void
}

export type KeymaxxerUpstreamClient = {
  readonly callTool: (input: {
    readonly name: string
    readonly arguments: Record<string, unknown>
  }) => Promise<{
    content?: unknown
    isError?: boolean
    structuredContent?: unknown
  }>
  readonly close: () => Promise<void>
}

type UpstreamToolResult = {
  content?: unknown
  isError?: boolean
  structuredContent?: unknown
}

const createCapability = () => randomBytes(32).toString("base64url")

const constantTimeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const toolResultText = (result: { readonly content?: unknown }): string =>
  Array.isArray(result.content)
    ? result.content
        .map((item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
            ? item.text
            : "",
        )
        .join("\n")
    : ""

const makeDialogLane = () => {
  let chain: Promise<void> = Promise.resolve()
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const wait = chain
    chain = gate
    await wait
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

const createDefaultUpstream = async (
  options: StartFacadeOptions,
): Promise<KeymaxxerUpstreamClient> => {
  const environment = options.environment ?? process.env
  const launch = options.keymaxxerCommand ?? keymaxxerMcpCommand(environment)
  const client = new Client({
    name: "keymaxxer-sidecar-facade",
    version: "0.0.0",
  })
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: keymaxxerEnvironment(environment),
    stderr: "pipe",
  })
  transport.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trimEnd()
    if (text) options.log?.(`[keyholder] ${text}`)
  })
  await client.connect(transport)
  return {
    callTool: (input) =>
      client.callTool(input).then(
        (result) =>
          result as {
            content?: unknown
            isError?: boolean
            structuredContent?: unknown
          },
      ),
    close: () => transport.close(),
  }
}

const exhaustedUnlockError = (): UpstreamToolResult => ({
  content: [
    {
      type: "text",
      text: `error: vault unlock failed after ${MAX_UNLOCK_ATTEMPTS} attempts (wrong passphrase).`,
    },
  ],
  isError: true,
})

export const startKeymaxxerFacade = async (
  options: StartFacadeOptions = {},
): Promise<FacadeHandle> => {
  const host = options.host ?? "127.0.0.1"
  const capability = createCapability()
  const dialogLane = makeDialogLane()
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const log = options.log ?? ((message: string) => console.error(message))

  let upstream: KeymaxxerUpstreamClient | null = null
  let upstreamPromise: Promise<KeymaxxerUpstreamClient> | null = null
  let unlockObserved = false
  /** Shared in-flight unlock so concurrent waiters share one probe outcome. */
  let unlockInFlight: Promise<UpstreamToolResult> | null = null

  const ensureUpstream = () => {
    if (upstream) return Promise.resolve(upstream)
    if (upstreamPromise) return upstreamPromise
    upstreamPromise = (
      options.createUpstream ?? (() => createDefaultUpstream(options))
    )()
      .then((client) => {
        upstream = client
        return client
      })
      .catch((error) => {
        upstreamPromise = null
        throw error
      })
    return upstreamPromise
  }

  const callUpstream = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<UpstreamToolResult> => {
    const client = await ensureUpstream()
    try {
      return await client.callTool({ name, arguments: args })
    } catch (error) {
      if (upstream === client) {
        upstream = null
        upstreamPromise = null
        unlockObserved = false
      }
      await client.close().catch(() => undefined)
      throw error
    }
  }

  /**
   * Note a locked-vault list failure so later traffic re-enters the unlock path.
   * Wrong passphrase is the only Keymaxxer 0.2.x signal we treat as re-lock.
   */
  const noteListResult = (result: UpstreamToolResult): UpstreamToolResult => {
    if (isWrongPassphraseResult(result)) {
      unlockObserved = false
    }
    return result
  }

  /**
   * Serialized unlock probe via metadata-only `keymaxxer_list`.
   * Wrong passphrase is retried up to MAX_UNLOCK_ATTEMPTS; other failures are not.
   * Must run inside the dialog lane (via {@link sharedUnlockProbe}).
   */
  const unlockProbe = async (): Promise<UpstreamToolResult> => {
    if (unlockObserved) {
      return noteListResult(await callUpstream("keymaxxer_list", {}))
    }

    log("[facade] waiting for vault unlock")

    for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
      const result = await callUpstream("keymaxxer_list", {})
      if (result.isError !== true) {
        unlockObserved = true
        return result
      }

      if (isWrongPassphraseResult(result)) {
        if (attempt < MAX_UNLOCK_ATTEMPTS) {
          log(
            `[facade] vault unlock attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS} failed (wrong passphrase); retrying`,
          )
          continue
        }
        log(
          `[facade] vault unlock exhausted after ${MAX_UNLOCK_ATTEMPTS} wrong-passphrase attempts`,
        )
        return exhaustedUnlockError()
      }

      // Non-retryable unlock failure (e.g. no vault) — surface immediately.
      return result
    }

    // Loop always returns on the final attempt; keep a defensive exhausted path.
    return exhaustedUnlockError()
  }

  /**
   * Single-flight unlock: concurrent waiters share one probe result.
   * A later independent request may start a new probe after this settles.
   */
  const sharedUnlockProbe = (): Promise<UpstreamToolResult> => {
    if (unlockInFlight !== null) return unlockInFlight
    unlockInFlight = dialogLane(unlockProbe).then(
      (result) => {
        unlockInFlight = null
        return result
      },
      (error) => {
        unlockInFlight = null
        throw error
      },
    )
    return unlockInFlight
  }

  /**
   * Ensure the vault is unlocked before a dialog-producing operation.
   * Success is decided from the probe result only — do not re-read the shared
   * `unlockObserved` flag after the dialog lane releases (TOCTOU with transport
   * recovery). Never return a successful list payload as a run/add outcome.
   */
  const ensureUnlocked = async (): Promise<UpstreamToolResult | null> => {
    if (unlockObserved) return null
    const result = await sharedUnlockProbe()
    if (result.isError === true) {
      return result
    }
    return null
  }

  const forwardTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<UpstreamToolResult> => {
    if (name === "keymaxxer_list") {
      // Once unlocked, metadata-only list bypasses a run/add waiting on approval.
      if (unlockObserved) {
        return noteListResult(await callUpstream(name, args))
      }
      return sharedUnlockProbe()
    }

    // Dialog-producing operations: unlock first (separate dialog-lane acquisition
    // so metadata list can proceed while this op later waits on approval), then
    // re-check unlock inside the op lane before calling upstream. Re-check covers
    // transport recovery or concurrent re-lock that clears unlockObserved after
    // ensureUnlocked returned. Call unlockProbe directly here — not
    // sharedUnlockProbe — to avoid re-entering dialogLane while holding it.
    if (!unlockObserved) {
      const unlockFailure = await ensureUnlocked()
      if (unlockFailure !== null) {
        return unlockFailure
      }
    }

    return dialogLane(async () => {
      if (!unlockObserved) {
        log(`[facade] re-probing vault unlock before ${name}`)
        const unlockResult = await unlockProbe()
        if (unlockResult.isError === true) {
          return unlockResult
        }
      }
      // No preemptive per-call "may require operator interaction" log: the facade
      // cannot know if Keymaxxer will dialog, and that line spam looks stuck after
      // Allow-session (#547). Unlock waits stay in unlockProbe only.
      return callUpstream(name, args)
    })
  }

  const createServer = () => {
    const server = new McpServer({
      name: "keymaxxer-sidecar",
      version: "0.0.0",
    })

    server.registerTool(
      "keymaxxer_list",
      {
        description:
          "List the secrets in the vault with their attributes. Returns NO secret values.",
        inputSchema: {},
      },
      async () => {
        const result = await forwardTool("keymaxxer_list", {})
        return result as {
          content: { type: "text"; text: string }[]
          isError?: boolean
        }
      },
    )

    server.registerTool(
      "keymaxxer_run",
      {
        description:
          "Run a shell command with secrets injected. Secret values are scrubbed from output.",
        inputSchema: {
          command: z.string(),
          secrets: z.array(z.string()),
          cwd: z.string().optional(),
          timeoutMs: z.number().optional(),
        },
      },
      async (args) => {
        const result = await forwardTool("keymaxxer_run", args)
        return result as {
          content: { type: "text"; text: string }[]
          isError?: boolean
        }
      },
    )

    server.registerTool(
      "keymaxxer_add",
      {
        description: "Add a secret (value never returned).",
        inputSchema: {
          name: z.string(),
          provider: z.string().optional(),
          account: z.string().optional(),
          environment: z.string().optional(),
          access: z.string().optional(),
          description: z.string().optional(),
          tags: z.string().optional(),
        },
      },
      async (args) => {
        const result = await forwardTool("keymaxxer_add", args)
        return result as {
          content: { type: "text"; text: string }[]
          isError?: boolean
        }
      },
    )

    return server
  }

  const handleMcp = async (request: Request): Promise<Response> => {
    const sessionId = request.headers.get("mcp-session-id")
    let body: unknown
    if (request.method === "POST") {
      body = await request.json()
    }

    if (sessionId) {
      const transport = transports.get(sessionId)
      if (transport) {
        return transport.handleRequest(request, { parsedBody: body })
      }
    }

    if (!sessionId && request.method === "POST" && isInitializeRequest(body)) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport)
        },
        onsessionclosed: (id) => {
          transports.delete(id)
        },
      })
      transport.onclose = () => {
        const id = transport.sessionId
        if (id) transports.delete(id)
      }
      const server = createServer()
      await server.connect(transport)
      return transport.handleRequest(request, { parsedBody: body })
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: host,
      port: options.port ?? 0,
      fetch: async (request) => {
        if (request.headers.get("origin")) {
          return new Response("browser requests are forbidden", { status: 403 })
        }

        const url = new URL(request.url)
        const parts = url.pathname.split("/").filter(Boolean)
        const pathCapability = parts[0]
        if (
          parts.length !== 2 ||
          parts[1] !== "mcp" ||
          pathCapability === undefined
        ) {
          return new Response("not found", { status: 404 })
        }
        if (!constantTimeEqual(pathCapability, capability)) {
          return new Response("not found", { status: 404 })
        }

        try {
          return await handleMcp(request)
        } catch (error) {
          log(`[facade] request error: ${String(error)}`)
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          )
        }
      },
    })
  } catch {
    throw new Error(
      `Keymaxxer Sidecar failed to listen on ${host}:${options.port ?? 0}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`,
    )
  }

  const port = server.port
  if (port === undefined) {
    server.stop(true)
    throw new Error(
      `Keymaxxer Sidecar failed to listen on ${host}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`,
    )
  }
  const url = `http://${host}:${port}/${capability}/mcp`
  const onBootstrap =
    options.onBootstrapUrl ??
    ((value: string) => {
      process.stdout.write(`${KEYMAXXER_SIDECAR_URL_PREFIX}${value}\n`)
    })
  onBootstrap(url)
  log(`Keymaxxer Sidecar listening on ${host}:${port}`)

  return {
    url,
    port,
    hostname: host,
    stop: async () => {
      for (const transport of transports.values()) {
        await transport.close().catch(() => undefined)
      }
      transports.clear()
      await upstream?.close().catch(() => undefined)
      upstream = null
      upstreamPromise = null
      server.stop(true)
    },
  }
}
