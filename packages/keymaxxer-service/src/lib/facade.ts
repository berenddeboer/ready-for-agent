import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { mcpToolCallTimeoutMs } from "./config.js"
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
  /**
   * Number of live Layer A Streamable HTTP MCP sessions.
   * Client DELETE / transport close drops a session; does not include Layer B.
   */
  readonly activeHttpSessionCount: () => number
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

/** Thrown when a caller is removed before acquiring the global dialog lane. */
export class DialogLaneCancelledError extends Error {
  constructor(message = "request cancelled before dialog lane") {
    super(message)
    this.name = "DialogLaneCancelledError"
  }
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

const isTimeoutError = (error: unknown): boolean => {
  if (typeof error === "object" && error !== null && "code" in error) {
    // MCP SDK ErrorCode.RequestTimeout
    if ((error as { code: unknown }).code === -32001) return true
  }
  if (error instanceof Error) {
    return /timed out|timeout/i.test(error.message)
  }
  return false
}

const errorMessageSafe = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Wait for a shared promise, but leave that promise running if this waiter is
 * aborted (e.g. shared unlock must not be cancelled for remaining waiters).
 */
const raceAbort = async <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (signal === undefined) return promise
  if (signal.aborted) throw new DialogLaneCancelledError()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new DialogLaneCancelledError())
    }
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

type DialogLaneOptions = {
  readonly signal?: AbortSignal
  readonly onQueueWait?: () => void
}

/**
 * Global human-dialog mutex with cancellable waiters.
 * A waiter aborted before it acquires the lane is removed and never runs `fn`.
 * Once `fn` starts (forwarded upstream), abort does not stop `fn` and does not
 * clear shared vault state — the result may simply never be delivered.
 */
const makeDialogLane = () => {
  type Entry = {
    readonly proceed: () => void
    readonly fail: (error: unknown) => void
    settled: boolean
  }

  let active: Entry | null = null
  const queue: Entry[] = []

  const removeFromQueue = (entry: Entry) => {
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index)
  }

  const startNext = () => {
    if (active !== null) return
    while (queue.length > 0) {
      const entry = queue.shift()
      if (entry === undefined) return
      if (entry.settled) continue
      active = entry
      entry.settled = true
      entry.proceed()
      return
    }
  }

  return async <T>(
    fn: () => Promise<T>,
    options: DialogLaneOptions = {},
  ): Promise<T> => {
    const { signal, onQueueWait } = options
    if (signal?.aborted) {
      throw new DialogLaneCancelledError()
    }

    const needsWait = active !== null || queue.length > 0
    if (needsWait) {
      onQueueWait?.()
    }

    await new Promise<void>((resolve, reject) => {
      const entry: Entry = {
        proceed: () => {
          resolve()
        },
        fail: (error) => {
          reject(error)
        },
        settled: false,
      }

      const onAbort = () => {
        // Already acquired: leave in-flight work alone (no replay, no vault clear).
        if (active === entry) return
        removeFromQueue(entry)
        if (!entry.settled) {
          entry.settled = true
          entry.fail(new DialogLaneCancelledError())
        }
      }

      if (signal !== undefined) {
        if (signal.aborted) {
          entry.settled = true
          entry.fail(new DialogLaneCancelledError())
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }

      queue.push(entry)
      startNext()
    })

    try {
      return await fn()
    } finally {
      active = null
      startNext()
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
      client
        .callTool(input, undefined, {
          timeout: mcpToolCallTimeoutMs(input.name, input.arguments),
        })
        .then(
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

const cancelledToolResult = (): UpstreamToolResult => ({
  content: [{ type: "text", text: "error: request cancelled" }],
  isError: true,
})

const timeoutToolResult = (name: string): UpstreamToolResult => ({
  content: [
    {
      type: "text",
      text: `error: keymaxxer ${name} timed out waiting for the keyholder`,
    },
  ],
  isError: true,
})

const executionFailureResult = (name: string): UpstreamToolResult => ({
  content: [
    {
      type: "text",
      text: `error: keymaxxer ${name} failed`,
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
      if (isTimeoutError(error)) {
        log(`[facade] upstream ${name} timed out`)
        // Timeouts are not keyholder death; keep the upstream client.
        return timeoutToolResult(name)
      }
      log(
        `[facade] upstream ${name} execution failed: ${errorMessageSafe(error)}`,
      )
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
   * Never cancelled once started — shared vault session benefit.
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
   * The probe itself is not abortable; individual waiters may race-abort.
   */
  const sharedUnlockProbe = (): Promise<UpstreamToolResult> => {
    if (unlockInFlight !== null) return unlockInFlight
    unlockInFlight = dialogLane(unlockProbe, {
      onQueueWait: () => log("[facade] waiting for dialog lane (unlock)"),
    }).then(
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
  const ensureUnlocked = async (
    signal?: AbortSignal,
  ): Promise<UpstreamToolResult | null> => {
    if (unlockObserved) return null
    const result = await raceAbort(sharedUnlockProbe(), signal)
    if (result.isError === true) {
      return result
    }
    return null
  }

  const forwardTool = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<UpstreamToolResult> => {
    try {
      if (name === "keymaxxer_list") {
        // Once unlocked, metadata-only list bypasses a run/add waiting on approval.
        if (unlockObserved) {
          if (signal?.aborted) throw new DialogLaneCancelledError()
          return noteListResult(await callUpstream(name, args))
        }
        return await raceAbort(sharedUnlockProbe(), signal)
      }

      // Dialog-producing operations: unlock first (separate dialog-lane acquisition
      // so metadata list can proceed while this op later waits on approval), then
      // re-check unlock inside the op lane before calling upstream. Re-check covers
      // transport recovery or concurrent re-lock that clears unlockObserved after
      // ensureUnlocked returned. Call unlockProbe directly here — not
      // sharedUnlockProbe — to avoid re-entering dialogLane while holding it.
      if (!unlockObserved) {
        const unlockFailure = await ensureUnlocked(signal)
        if (unlockFailure !== null) {
          return unlockFailure
        }
      }

      return await dialogLane(
        async () => {
          if (!unlockObserved) {
            log(`[facade] re-probing vault unlock before ${name}`)
            const unlockResult = await unlockProbe()
            if (unlockResult.isError === true) {
              return unlockResult
            }
          }
          // No preemptive per-call "may require operator interaction" log: the facade
          // cannot know if Keymaxxer will dialog, and that line spam looks stuck after
          // Allow-session. Unlock waits stay in unlockProbe only.
          try {
            return await callUpstream(name, args)
          } catch {
            // callUpstream already logs and converts timeouts; remaining throws
            // are execution/transport failures (client already invalidated).
            return executionFailureResult(name)
          }
        },
        {
          signal,
          onQueueWait: () => log(`[facade] waiting for dialog lane (${name})`),
        },
      )
    } catch (error) {
      if (error instanceof DialogLaneCancelledError) {
        // Caller left before delivery; SDK already dropped the response when aborted.
        return cancelledToolResult()
      }
      throw error
    }
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
      async (_args, extra) => {
        const result = await forwardTool("keymaxxer_list", {}, extra.signal)
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
      async (args, extra) => {
        const result = await forwardTool("keymaxxer_run", args, extra.signal)
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
      async (args, extra) => {
        const result = await forwardTool("keymaxxer_add", args, extra.signal)
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
    activeHttpSessionCount: () => transports.size,
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
