import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { keymaxxerEnvironment, keymaxxerMcpCommand } from "./mcp-layer.js"

export const KEYMAXXER_SIDECAR_URL_PREFIX = "KEYMAXXER_SIDECAR_URL="

export const TOOL_NAMES = [
  "keymaxxer_list",
  "keymaxxer_run",
  "keymaxxer_add",
  "keymaxxer_rm",
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

const createCapability = () => randomBytes(32).toString("base64url")

const constantTimeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

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

  const forwardTool = async (name: string, args: Record<string, unknown>) => {
    const client = await ensureUpstream()
    const needsDialogLane =
      name === "keymaxxer_run" || name === "keymaxxer_add" || !unlockObserved

    const call = async () => {
      try {
        const result = await client.callTool({ name, arguments: args })
        if (!result.isError) unlockObserved = true
        return result
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

    if (needsDialogLane) return dialogLane(call)
    return call()
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

    server.registerTool(
      "keymaxxer_rm",
      {
        description: "Remove a secret by name.",
        inputSchema: { name: z.string() },
      },
      async (args) => {
        const result = await forwardTool("keymaxxer_rm", args)
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
