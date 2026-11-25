/**
 * Real OpenCode V2 contract. Every passing launch goes through a production
 * entry point and the installed binary. See packages/opencode/CLI-CONTRACT.md.
 *
 * Inference-triggering turns stop at the model-unavailable boundary or use
 * a loopback provider to prove interruption and prompt-scoped replies.
 * No cloud model is called.
 */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Context, Effect, Fiber, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  AgentBackend,
  AgentBackendConfigError,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendTimeoutError,
  PROMPT_ARGV_BYTE_LIMIT,
  type PendingImplementStop,
} from "@ready-for-agent/agent-backend"
import {
  formatGateLog,
  gateOpenCodeContract,
} from "../../../scripts/opencode-contract-gate.ts"
import {
  type ServerPlacementCapability,
  serverPlacementCapability,
} from "../../../scripts/opencode-server-placement.ts"
import { Opencode } from "../src/index.js"
import {
  OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
  type OwnedOpenCodeServer,
  openCodeBasicAuthHeaders,
  startOwnedOpenCodeServer,
} from "../src/lib/owned-server.js"
import { parseCommandTranscript } from "../src/lib/parse-command-transcript.js"
import { readOpenCodeServiceStatus } from "../src/lib/resolve-server-base.js"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const KEYMAXXER_URL = "http://127.0.0.1:9/ber35-cli-contract/mcp"
const UNKNOWN_MODEL = "ready-for-agent-contract/no-such-model"
const MODEL_UNAVAILABLE = `Model unavailable: ${UNKNOWN_MODEL}`
const BLOCKED_MODEL = "contract-loopback/blocked"
const REPLY_MODEL = "contract-loopback/reply"
const PREVIOUS_HANDOFF = "BER-57 previous handoff"
const CURRENT_HANDOFF = "BER-57 current handoff\nInvestigate the status checks."
const BACKGROUND_OUTPUT = "ber57-background-job-finished"
const BACKGROUND_REPLY = "Twenty local scenarios passed."
const TRUNCATED_REPLY = "I investigated the failure and began to"
const HANDOFF_REPLY =
  "Replacement execution queued.\nREADY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"
const UNRECOGNIZED_SERVER_RUN =
  "Unrecognized flag: --server in command opencode run"
const UNRECOGNIZED_SERVER_API =
  "Unrecognized flag: --server in command opencode api"
const UNRECOGNIZED_SERVER_SESSION =
  "Unrecognized flag: --server in command opencode session"
const UNRECOGNIZED_VERBOSE =
  "Unrecognized flag: --verbose in command opencode models"
const CASE_TIMEOUT_MS = 45_000

const gated = gateOpenCodeContract()
if (!gated.ok) {
  throw new Error(gated.message)
}
const binary = gated.binary
const versionLine = gated.versionLine
console.log(formatGateLog(gated))

type LaunchRecord = {
  readonly args: ReadonlyArray<string>
  stdout: string
  stderr: string
}

type Fixture = {
  readonly root: string
  readonly cwd: string
  readonly otherCwd: string
  readonly env: Record<string, string>
  readonly explicitEnv: Record<string, string>
  readonly standaloneEnv: Record<string, string>
  readonly owned: OwnedOpenCodeServer
  readonly providerRequests: ReadonlyArray<string>
  readonly providerCancellations: ReadonlyArray<string>
  readonly secrets: ReadonlyArray<string>
  dispose: () => Promise<void>
}

type OpenCodeBackend = Context.Service.Shape<typeof AgentBackend>

const startedAt = performance.now()
let operatorServiceUrl: string | undefined
let fixture: Fixture | undefined
let chain: Promise<unknown> = Promise.resolve()

const exclusive = async <A>(use: () => Promise<A>): Promise<A> => {
  const previous = chain
  let release: () => void = () => undefined
  chain = new Promise((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await use()
  } finally {
    release()
  }
}

const redact = (text: string, secrets: ReadonlyArray<string>): string => {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]")
    }
  }
  return redacted
}

const truncate = (text: string): string =>
  text.length <= 600 ? text : `${text.slice(0, 600)}…`

const diagnostic = (
  records: ReadonlyArray<LaunchRecord>,
  secrets: ReadonlyArray<string>,
): string =>
  redact(
    JSON.stringify(
      records.map((record) => ({
        argv: record.args,
        stdout: truncate(record.stdout),
        stderr: truncate(record.stderr),
      })),
      null,
      2,
    ),
    secrets,
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const jsonObject = (text: string): Record<string, unknown> | undefined => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const locationDirectory = (stdout: string): string | undefined => {
  const body = jsonObject(stdout)
  if (body === undefined || !isRecord(body.location)) {
    return undefined
  }
  return typeof body.location.directory === "string"
    ? body.location.directory
    : undefined
}

const opencodeArgIndex = (args: ReadonlyArray<string>): number =>
  args.findIndex((arg) => arg === "opencode" || arg.endsWith("/opencode"))

const teeHandle = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  record: LaunchRecord,
): ChildProcessSpawner.ChildProcessHandle =>
  new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === "stdout" || prop === "stderr") {
        const stream = prop === "stdout" ? target.stdout : target.stderr
        return stream.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              const text = new TextDecoder().decode(chunk)
              if (prop === "stdout") {
                record.stdout += text
              } else {
                record.stderr += text
              }
            }),
          ),
        )
      }
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })

const wrapSpawner = (
  real: ChildProcessSpawner.ChildProcessSpawner["Service"],
  records: LaunchRecord[],
  mutate?: (cliArgs: ReadonlyArray<string>) => ReadonlyArray<string>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return real.spawn(command)
    }
    const binaryAt = opencodeArgIndex(command.args)
    if (binaryAt < 0) {
      return real.spawn(command)
    }
    const cliArgs = command.args.slice(binaryAt + 1)
    const nextArgs = mutate === undefined ? cliArgs : mutate(cliArgs)
    const record: LaunchRecord = { args: nextArgs, stdout: "", stderr: "" }
    records.push(record)
    const spawned =
      nextArgs === cliArgs
        ? command
        : ChildProcess.make(
            command.command,
            [...command.args.slice(0, binaryAt + 1), ...nextArgs],
            command.options,
          )
    return real
      .spawn(spawned)
      .pipe(Effect.map((handle) => teeHandle(handle, record)))
  })

const moveServerBefore = (
  cliArgs: ReadonlyArray<string>,
  command: string,
): ReadonlyArray<string> => {
  const flagAt = cliArgs.indexOf("--server")
  const url = cliArgs[flagAt + 1]
  const commandAt = cliArgs.indexOf(command)
  if (flagAt < 0 || url === undefined || url.startsWith("-") || commandAt < 0) {
    throw new Error(`production argv is missing --server or ${command}`)
  }
  if (flagAt < commandAt) {
    throw new Error(`production already placed --server before ${command}`)
  }
  const without = [...cliArgs.slice(0, flagAt), ...cliArgs.slice(flagAt + 2)]
  const commandAtNow = without.indexOf(command)
  return [
    ...without.slice(0, commandAtNow),
    "--server",
    url,
    ...without.slice(commandAtNow),
  ]
}

const insertRunFlag = (
  cliArgs: ReadonlyArray<string>,
  flag: string,
  value?: string,
): ReadonlyArray<string> => {
  if (cliArgs.includes(flag)) {
    throw new Error(`production run argv already contains ${flag}`)
  }
  const runAt = cliArgs.indexOf("run")
  if (runAt < 0) {
    throw new Error("production argv is not a run command")
  }
  return [
    ...cliArgs.slice(0, runAt + 1),
    flag,
    ...(value === undefined ? [] : [value]),
    ...cliArgs.slice(runAt + 1),
  ]
}

const placementCapability = () =>
  serverPlacementCapability({
    version: gated.version,
    baseline: gated.baseline,
    mode: gated.mode,
  })

const flagBefore = (
  args: ReadonlyArray<string>,
  command: string,
): {
  readonly flagAt: number
  readonly url: string
  readonly commandAt: number
} => {
  const flagAt = args.indexOf("--server")
  const url = args[flagAt + 1]
  const commandAt = args.indexOf(command)
  if (flagAt < 0 || url === undefined || url.startsWith("-") || commandAt < 0) {
    throw new Error(`argv is missing --server or ${command}: ${args.join(" ")}`)
  }
  return { flagAt, url, commandAt }
}

const assertHistoricalServerRejection = (
  error: unknown,
  diagnosticText: string,
  records: ReadonlyArray<LaunchRecord>,
  secrets: ReadonlyArray<string>,
): void => {
  expect(error, diagnostic(records, secrets)).toBeInstanceOf(
    AgentBackendExitError,
  )
  if (!(error instanceof AgentBackendExitError)) {
    return
  }
  expect(error.message).toContain(diagnosticText)
  expect(error.message.match(/Unrecognized flag:/g)).toEqual([
    "Unrecognized flag:",
  ])
  expect(error.message).not.toContain("Model unavailable")
  expect(error.message).not.toContain("Could not reach server")
  expect(error.sessionId).toBeUndefined()
}

const textParts = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((part) => {
    if (
      !isRecord(part) ||
      part.type !== "text" ||
      typeof part.text !== "string"
    ) {
      return []
    }
    const text = part.text.trim()
    return text.length > 0 ? [text] : []
  })
}

/** Assistant, synthetic, or system text a command export could satisfy. */
const commandResultTexts = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    return value.flatMap(commandResultTexts)
  }
  if (!isRecord(value)) {
    return []
  }
  const own: string[] = []
  if (value.type === "assistant") {
    own.push(...textParts(value.content))
    if (typeof value.text === "string" && value.text.trim().length > 0) {
      own.push(value.text.trim())
    }
  }
  if (
    (value.type === "synthetic" || value.type === "system") &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  ) {
    own.push(value.text.trim())
  }
  return [...own, ...Object.values(value).flatMap(commandResultTexts)]
}

const parsedExport = (
  stdout: string,
): {
  readonly id: string
  readonly directory: string
  readonly body: unknown
} => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`export stdout is not JSON: ${stdout.slice(0, 300)}`)
  }
  if (!isRecord(parsed)) {
    throw new Error("export stdout is not a JSON object")
  }
  const info = isRecord(parsed.info) ? parsed.info : parsed
  const location = isRecord(info.location) ? info.location : undefined
  if (typeof info.id !== "string" || typeof location?.directory !== "string") {
    throw new Error(
      `export JSON has no session id and worktree: ${JSON.stringify(info).slice(0, 400)}`,
    )
  }
  return { id: info.id, directory: location.directory, body: parsed }
}

const assertStoredOnce = (
  messages: ReadonlyArray<Record<string, unknown>>,
  text: string,
): void => {
  expect(messages.filter((message) => message.text === text)).toHaveLength(1)
}

const registerIsolatedService = async (
  env: Record<string, string>,
  owned: OwnedOpenCodeServer,
): Promise<void> => {
  const response = await fetch(`${owned.baseUrl}/api/info`, {
    headers: owned.headers,
    signal: AbortSignal.timeout(5_000),
  })
  const body: unknown = await response.json()
  if (
    !isRecord(body) ||
    typeof body.version !== "string" ||
    typeof body.pid !== "number"
  ) {
    throw new Error("ephemeral OpenCode server did not return version and pid")
  }
  const directory = join(env.XDG_STATE_HOME ?? "", "opencode")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "service.json"),
    JSON.stringify({
      id: "ready-for-agent-contract",
      version: body.version,
      url: owned.baseUrl,
      pid: body.pid,
      password: owned.password,
    }),
  )
}

const openFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "opencode-cli-contract-"))
  const cwd = join(root, 'work "item"')
  const otherCwd = join(root, "other dir")
  const home = join(root, "home")
  const config = join(root, "config")
  const data = join(root, "data")
  const state = join(root, "state")
  const cache = join(root, "cache")
  const explicitState = join(root, "explicit-state")
  const standaloneConfig = join(root, "standalone-config")
  await mkdir(home, { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(data, { recursive: true })
  await mkdir(state, { recursive: true })
  await mkdir(cache, { recursive: true })
  await mkdir(explicitState, { recursive: true })
  await mkdir(join(standaloneConfig, "opencode"), { recursive: true })
  await writeFile(
    join(standaloneConfig, "opencode", "service.json"),
    JSON.stringify({ disabled: true }),
  )
  await mkdir(cwd, { recursive: true })
  await mkdir(otherCwd, { recursive: true })
  const providerRequests: string[] = []
  const providerCancellations: string[] = []
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text()
      providerRequests.push(body)
      const parsed = jsonObject(body)
      if (parsed?.model === "reply") {
        const last: unknown = Array.isArray(parsed.messages)
          ? parsed.messages.at(-1)
          : undefined
        const content = isRecord(last) ? JSON.stringify(last.content) : ""
        if (
          content?.includes("<shell") &&
          content.includes(BACKGROUND_OUTPUT)
        ) {
          return chatReply({ content: BACKGROUND_REPLY })
        }
        if (
          Array.isArray(parsed.messages) &&
          parsed.messages.some(
            (message: unknown) =>
              isRecord(message) &&
              message.role === "assistant" &&
              JSON.stringify(message.content)?.includes(TRUNCATED_REPLY),
          )
        ) {
          return chatReply({ content: HANDOFF_REPLY })
        }
        if (isRecord(last) && last.role === "tool") {
          return chatReply({ content: TRUNCATED_REPLY }, "length")
        }
        if (content?.includes("BER-57 current handoff")) {
          return chatReply(
            {
              content: "Investigating.",
              tool_calls: [
                {
                  index: 0,
                  id: "call_ber57",
                  type: "function",
                  function: {
                    name: "shell",
                    arguments: JSON.stringify({
                      command: `sleep 1 && echo ${BACKGROUND_OUTPUT}`,
                      description: "Run local tests in the background",
                      workdir: cwd,
                      background: true,
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          )
        }
        return chatReply({ content: "READY_FOR_AGENT_RESULT: PROCESSED" })
      }
      // Once inference starts, the only way for the turn to leave this
      // streaming response is for OpenCode to cancel it.
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            providerCancellations.push(body)
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
        },
      )
    },
  })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    TMPDIR: root,
    LANG: "C",
    TERM: "dumb",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      providers: {
        "contract-loopback": {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${provider.url.origin}/v1`, apiKey: "fixture" },
          models: {
            blocked: { name: "Blocked contract model" },
            reply: { name: "Reply contract model" },
          },
        },
      },
      commands: {
        review: {
          description: "Contract review",
          template: "Review $ARGUMENTS",
        },
        "owned-review": {
          template: "Review from !`cat command-location.txt`:\n$ARGUMENTS",
        },
      },
    }),
  }
  const owned = await startOwnedOpenCodeServer({
    keymaxxerMcpUrl: KEYMAXXER_URL,
    environment: env,
    cwd,
    readyTimeoutMs: 15_000,
  }).catch(async (error) => {
    await provider.stop(true)
    throw error
  })
  await registerIsolatedService(env, owned)
  let disposed = false
  return {
    root,
    cwd,
    otherCwd,
    env,
    explicitEnv: { ...env, XDG_STATE_HOME: explicitState },
    standaloneEnv: {
      ...env,
      XDG_STATE_HOME: explicitState,
      XDG_CONFIG_HOME: standaloneConfig,
    },
    owned,
    providerRequests,
    providerCancellations,
    secrets: [owned.password, KEYMAXXER_URL],
    dispose: async () => {
      if (disposed) {
        return
      }
      disposed = true
      await owned.dispose()
      await provider.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}

const chatReply = (
  delta: Record<string, unknown>,
  finish = "stop",
): Response => {
  const frame = (choice: Record<string, unknown>) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-ber57",
      object: "chat.completion.chunk",
      model: "reply",
      created: 1,
      choices: [{ index: 0, ...choice }],
    })}\n\n`
  return new Response(
    frame({ delta: { role: "assistant", ...delta }, finish_reason: null }) +
      frame({ delta: {}, finish_reason: finish }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

const requireFixture = (): Fixture => {
  if (fixture === undefined) {
    throw new Error("CLI contract fixture was not started")
  }
  return fixture
}

const runOwned = <A>(
  mode:
    | "default"
    | "explicit"
    | "non-owned-explicit"
    | "standalone"
    | { readonly dedicatedServer: OwnedOpenCodeServer },
  records: LaunchRecord[],
  use: (backend: OpenCodeBackend) => Effect.Effect<A, unknown>,
  mutate?: (cliArgs: ReadonlyArray<string>) => ReadonlyArray<string>,
): Promise<A> => {
  const current = requireFixture()
  return Effect.runPromise(
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const spawner = wrapSpawner(real, records, mutate)
      return yield* Effect.gen(function* () {
        return yield* use(yield* AgentBackend)
      }).pipe(
        Effect.provide(
          Opencode.layer({
            keymaxxerMcpUrl: KEYMAXXER_URL,
            environment:
              mode === "explicit" || typeof mode === "object"
                ? current.explicitEnv
                : mode === "non-owned-explicit"
                  ? {
                      ...current.explicitEnv,
                      OPENCODE_PASSWORD: current.owned.password,
                    }
                  : mode === "standalone"
                    ? current.standaloneEnv
                    : current.env,
            ...(mode === "explicit"
              ? { dedicatedServer: current.owned }
              : mode === "non-owned-explicit"
                ? { server: { baseUrl: current.owned.baseUrl } }
                : typeof mode === "object"
                  ? mode
                  : {}),
            defaultTimeout: "20 seconds",
            startupTimeout: "8 seconds",
          }).pipe(
            Layer.provide(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        ),
      )
    }).pipe(Effect.provide(BunServices.layer)),
  )
}

const expectedServerKey = (url: string, pid: number): string =>
  createHash("sha256")
    .update(JSON.stringify([url, pid]))
    .digest("hex")

// Forward to the actual owned server, then interfere only with the command
// acknowledgement. Session setup, wait, export and interrupt go through.
const openCommandResponseProxy = async (
  owned: OwnedOpenCodeServer,
  fault: "drop" | "hold",
) => {
  const commandRequests: string[] = []
  const commandResponses: number[] = []
  const proxy = createServer((req, res) => {
    const path = req.url ?? "/"
    const command = req.method === "POST" && path.endsWith("/command")
    if (command) commandRequests.push(path)
    const upstream = httpRequest(
      new URL(path, owned.baseUrl),
      { method: req.method, headers: req.headers },
      (response) => {
        if (!command) {
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
          return
        }
        response.resume()
        response.on("end", () => {
          commandResponses.push(response.statusCode ?? 0)
          if (fault === "drop") res.socket?.destroy()
        })
      },
    )
    upstream.on("error", () => res.destroy())
    req.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", resolve)
  })
  const address = proxy.address()
  if (address === null || typeof address === "string") {
    proxy.close()
    throw new Error("Missing command proxy port")
  }
  return {
    server: { ...owned, baseUrl: `http://127.0.0.1:${address.port}` },
    commandRequests,
    commandResponses,
    close: () => {
      proxy.close()
      proxy.closeAllConnections()
    },
  }
}

const sessionBody = async (
  owned: OwnedOpenCodeServer,
  sessionId: string,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${owned.baseUrl}/api/session/${sessionId}`, {
    headers: owned.headers,
    signal: AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  expect(response.status, text.slice(0, 300)).toBe(200)
  const body = jsonObject(text)
  if (body === undefined || !isRecord(body.data)) {
    throw new Error(`session response has no data: ${text.slice(0, 300)}`)
  }
  return body.data
}

const sessionMessages = async (
  owned: OwnedOpenCodeServer,
  sessionId: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const response = await fetch(
    `${owned.baseUrl}/api/session/${sessionId}/message`,
    {
      headers: owned.headers,
      signal: AbortSignal.timeout(5_000),
    },
  )
  const text = await response.text()
  expect(response.status, text.slice(0, 300)).toBe(200)
  const body = jsonObject(text)
  if (body === undefined || !Array.isArray(body.data)) {
    throw new Error(`message response has no data: ${text.slice(0, 300)}`)
  }
  return body.data.filter(isRecord)
}

const activeSessions = async (
  owned: OwnedOpenCodeServer,
): Promise<string[]> => {
  const response = await fetch(`${owned.baseUrl}/api/session/active`, {
    headers: owned.headers,
    signal: AbortSignal.timeout(5_000),
  })
  const body: unknown = await response.json()
  expect(response.ok).toBe(true)
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error("active sessions response has no data")
  }
  return Object.keys(body.data)
}

const modelOf = (
  session: Record<string, unknown>,
): Record<string, unknown> | undefined =>
  isRecord(session.model) ? session.model : undefined

const assertNoArgumentError = (text: string, detail: string): void => {
  expect(text, detail).not.toContain("Unrecognized flag:")
  expect(text, detail).not.toContain("Invalid value for flag")
  expect(text, detail).not.toContain("Unexpected positional argument")
}

const catalogRecord = (records: ReadonlyArray<LaunchRecord>): LaunchRecord => {
  const found = records.find(
    (record) => record.args[0] === "api" && record.args.includes("/api/model"),
  )
  if (found === undefined) {
    throw new Error(`catalog launch missing\n${JSON.stringify(records)}`)
  }
  return found
}

const logCase = (label: string, records: ReadonlyArray<LaunchRecord>): void => {
  const current = requireFixture()
  const argv = records
    .map((record) => redact(record.args.join(" "), current.secrets))
    .join(" || ")
  console.log(`[opencode-cli-contract] ${label} ${argv}`)
}

/**
 * Drift coverage probes a version that has no evidence record yet. The three
 * placement cases stay the same oracle; only the label and the failure text
 * differ, so a new release does not turn the scheduled job red before the
 * binary is exercised.
 */
const unprobedAcceptanceNote = (
  capability: ServerPlacementCapability,
): string => {
  if (capability.kind !== "unprobed-acceptance") {
    return ""
  }
  console.log(
    `[opencode-cli-contract] drift probe: OpenCode ${capability.version} is not recorded in scripts/opencode-server-placement.ts. The placement cases proved the boundary. Record the version with this run's evidence to stop probing it.`,
  )
  return ` (unprobed ${capability.version})`
}

const assertUnprobedAcceptance = (
  capability: ServerPlacementCapability,
  placement: string,
  error: unknown,
  records: ReadonlyArray<LaunchRecord>,
  secrets: ReadonlyArray<string>,
): void => {
  if (capability.kind !== "unprobed-acceptance") {
    return
  }
  if (
    error instanceof AgentBackendExitError &&
    error.message.includes("Unrecognized flag: --server")
  ) {
    throw new Error(
      `OpenCode ${capability.version} rejects --server before ${placement} again (BER-31). Drift coverage probed an unrecorded version and production places the flag there, so this is upstream drift, not a missing evidence record.\n${diagnostic(records, secrets)}`,
    )
  }
}

/**
 * Accepted `--server` before `api` or `export` must reach the same no-inference
 * command boundary as the supported path. Malformed output is that oracle only
 * when the export is valid and contains no command result. It is not success
 * by itself.
 */
const proveAcceptedCommandPlacement = async (input: {
  readonly current: Fixture
  readonly prompt: string
  readonly capability: ServerPlacementCapability
  readonly placement: string
  readonly mutate: (cliArgs: ReadonlyArray<string>) => ReadonlyArray<string>
  readonly assertArgv: (
    records: ReadonlyArray<LaunchRecord>,
    url: string,
  ) => void
}): Promise<ReadonlyArray<LaunchRecord>> => {
  const records: LaunchRecord[] = []
  let created: string | undefined
  const error = await runOwned(
    "non-owned-explicit",
    records,
    (backend) =>
      backend
        .startTurn({
          cwd: input.current.cwd,
          prompt: input.prompt,
          model: UNKNOWN_MODEL,
          thinkingLevel: null,
          command: "review",
          timeout: "20 seconds",
          onSessionId: (sessionId) =>
            Effect.sync(() => {
              created = sessionId
            }),
        })
        .pipe(Effect.flip),
    input.mutate,
  )
  const detail = diagnostic(records, input.current.secrets)
  assertUnprobedAcceptance(
    input.capability,
    input.placement,
    error,
    records,
    input.current.secrets,
  )
  expect(created, detail).toMatch(/^ses_[A-Za-z0-9]+$/)
  if (created === undefined) {
    throw new Error(detail)
  }
  input.assertArgv(records, input.current.owned.baseUrl)

  const session = await sessionBody(input.current.owned, created)
  expect(
    isRecord(session.location) ? session.location.directory : undefined,
    detail,
  ).toBe(input.current.cwd)
  const model = modelOf(session)
  expect(model?.providerID).toBe("ready-for-agent-contract")
  expect(model?.id).toBe("no-such-model")
  const messages = await sessionMessages(input.current.owned, created)
  assertStoredOnce(messages, `Review ${input.prompt}`)

  const exported = records.find(
    (record) => record.args[0] === "session" && record.args.includes("export"),
  )
  expect(exported, detail).toBeDefined()
  if (exported === undefined) {
    throw new Error(detail)
  }
  const transcript = parsedExport(exported.stdout)
  expect(transcript.id).toBe(created)
  expect(transcript.directory).toBe(input.current.cwd)
  const resultTexts = commandResultTexts(transcript.body)
  if (resultTexts.length > 0 || /<task_result>\s*\S/i.test(exported.stdout)) {
    throw new Error(
      `export contained a command result the harness did not accept. This is an export compatibility problem, not a placement success.\n${detail}`,
    )
  }
  expect(
    parseCommandTranscript({
      transcript: exported.stdout,
      command: "review",
      startedAfterMs: 0,
    }),
  ).toBeUndefined()
  assertNoArgumentError(`${exported.stdout}\n${exported.stderr}`, detail)
  const wait = records.find((record) =>
    record.args.some((arg) => arg.includes("/wait")),
  )
  expect(wait, detail).toBeDefined()
  assertNoArgumentError(`${wait?.stdout ?? ""}\n${wait?.stderr ?? ""}`, detail)

  expect(error, detail).toBeInstanceOf(AgentBackendMalformedOutputError)
  expect(error, detail).not.toBeInstanceOf(AgentBackendExitError)
  if (error instanceof AgentBackendMalformedOutputError) {
    expect(error.cwd).toBe(input.current.cwd)
    expect(error.byteLength).toBe(Buffer.byteLength(exported.stdout, "utf8"))
  }
  return records
}

describe("installed OpenCode V2 production CLI contract", () => {
  beforeAll(async () => {
    try {
      operatorServiceUrl = (await readOpenCodeServiceStatus()).trim()
    } catch {
      operatorServiceUrl = undefined
    }
    fixture = await openFixture()
    console.log(
      `[opencode-cli-contract] binary=${binary} version=${versionLine}`,
    )
  }, CASE_TIMEOUT_MS)

  afterAll(async () => {
    await fixture?.dispose()
    const after = (await readOpenCodeServiceStatus().catch(() => "")).trim()
    if (operatorServiceUrl !== undefined) {
      expect(after).toBe(operatorServiceUrl)
    }
    console.log(
      `[opencode-cli-contract] elapsedMs=${String(Math.round(performance.now() - startedAt))}`,
    )
  }, CASE_TIMEOUT_MS)

  test(
    "version discovery and both catalog modes honor the worktree",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const defaultRecords: LaunchRecord[] = []
        const inspected = await runOwned("default", defaultRecords, (backend) =>
          backend.inspect({ cwd: current.otherCwd, timeout: "20 seconds" }),
        )
        expect(inspected.models.length).toBeGreaterThan(0)
        const versionLaunch = defaultRecords.find(
          (record) => record.args[0] === "--version",
        )
        expect(
          versionLaunch,
          diagnostic(defaultRecords, current.secrets),
        ).toBeDefined()
        expect(versionLaunch?.stdout ?? versionLaunch?.stderr).toContain("2.")
        const standalone = catalogRecord(defaultRecords)
        expect(standalone.args).toContain("--standalone")
        expect(standalone.args).not.toContain("--server")
        expect(locationDirectory(standalone.stdout)).toBe(current.otherCwd)
        assertNoArgumentError(
          `${standalone.stdout}\n${standalone.stderr}`,
          diagnostic(defaultRecords, current.secrets),
        )

        const explicitRecords: LaunchRecord[] = []
        const explicit = await runOwned(
          "explicit",
          explicitRecords,
          (backend) =>
            backend.inspect({ cwd: current.otherCwd, timeout: "20 seconds" }),
        )
        expect(explicit.models.length).toBeGreaterThan(0)
        const serverCatalog = catalogRecord(explicitRecords)
        expect(serverCatalog.args[0]).toBe("api")
        expect(serverCatalog.args[1]).toBe("--server")
        expect(serverCatalog.args).toContain(current.owned.baseUrl)
        expect(locationDirectory(serverCatalog.stdout)).toBe(current.otherCwd)
        expect(locationDirectory(serverCatalog.stdout)).not.toBe(current.cwd)
        assertNoArgumentError(
          `${serverCatalog.stdout}\n${serverCatalog.stderr}`,
          diagnostic(explicitRecords, current.secrets),
        )
        logCase("catalog", [...defaultRecords, ...explicitRecords])
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "serve binds loopback with auth and does not replace the operator service",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const cmdline = (
          await readFile(`/proc/${String(current.owned.pid)}/cmdline`)
        )
          .toString()
          .split("\0")
          .filter((part) => part.length > 0)
        expect(
          cmdline.some(
            (part) => part.endsWith("/opencode") || part === "opencode",
          ),
        ).toBe(true)
        expect(cmdline).toContain("serve")
        expect(cmdline).toContain("--hostname")
        expect(cmdline).toContain("127.0.0.1")
        expect(cmdline).not.toContain("--service")
        const portAt = cmdline.indexOf("--port")
        expect(current.owned.baseUrl).toBe(
          `http://127.0.0.1:${cmdline[portAt + 1] ?? ""}`,
        )
        const authed = await fetch(`${current.owned.baseUrl}/api/config`, {
          headers: current.owned.headers,
          signal: AbortSignal.timeout(5_000),
        })
        const authedBody = await authed.text()
        expect(authed.status).toBe(200)
        expect(authedBody).toContain(KEYMAXXER_URL)
        expect(authedBody).not.toContain(current.owned.password)
        const anonymous = await fetch(`${current.owned.baseUrl}/api/config`, {
          signal: AbortSignal.timeout(5_000),
        })
        expect(anonymous.status).toBe(401)
        if (operatorServiceUrl !== undefined) {
          expect(current.owned.baseUrl).not.toBe(operatorServiceUrl)
        }
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "service status reports the isolated service and not the operator",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const stopped = (
          await readOpenCodeServiceStatus({ env: current.explicitEnv })
        ).trim()
        expect(stopped).toBe("stopped")
        // A runner with no OpenCode service reports the same "stopped"
        // sentinel. That is not an operator URL to exclude.
        if (operatorServiceUrl?.includes("://") === true) {
          expect(stopped).not.toContain(operatorServiceUrl)
        }
        const discovered = (
          await readOpenCodeServiceStatus({ env: current.env })
        ).trim()
        expect(discovered).toBe(current.owned.baseUrl)
        expect(discovered).not.toBe(operatorServiceUrl)
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "prompt-scoped start and continuation export only the submitted reply, retaining background history",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        for (const mode of ["default", "explicit", "standalone"] as const) {
          const records: LaunchRecord[] = []
          const options = {
            cwd: current.cwd,
            model: REPLY_MODEL,
            thinkingLevel: null,
          }
          const { started, resumed, continued } = await runOwned(
            mode,
            records,
            (backend) =>
              Effect.gen(function* () {
                const pending: PendingImplementStop[] = []
                const cleared: PendingImplementStop[] = []
                const trackedInput = {
                  ...options,
                  prompt: PREVIOUS_HANDOFF,
                  replyToPromptOnly: true,
                  trackImplementStop: {
                    started: (target: PendingImplementStop) =>
                      Effect.sync(() => {
                        pending.push(target)
                      }),
                    stopped: (target: PendingImplementStop) =>
                      Effect.sync(() => {
                        cleared.push(target)
                      }),
                  },
                }
                const started = yield* backend.startTurn(trackedInput)
                const resumed = yield* backend.continueTurn({
                  ...trackedInput,
                  sessionId: started.sessionId,
                })
                expect(pending.map((target) => target.sessionId)).toEqual([
                  started.sessionId,
                  started.sessionId,
                ])
                expect(cleared).toEqual(pending)
                const continued = yield* backend.continueTurn({
                  ...options,
                  sessionId: started.sessionId,
                  prompt: CURRENT_HANDOFF,
                  replyToPromptOnly: true,
                })
                return { started, resumed, continued }
              }),
          )
          const detail = diagnostic(records, current.secrets)
          expect(started, detail).toEqual({
            sessionId: started.sessionId,
            assistantText: "READY_FOR_AGENT_RESULT: PROCESSED",
            precedingAssistantText: "",
          })
          expect(resumed, detail).toEqual(started)
          expect(continued, detail).toEqual({
            sessionId: started.sessionId,
            assistantText: HANDOFF_REPLY,
            precedingAssistantText: `Investigating.\n${TRUNCATED_REPLY}`,
          })
          const exportArgs = (explicit: boolean) =>
            explicit
              ? [
                  "session",
                  "export",
                  "--server",
                  current.owned.baseUrl,
                  started.sessionId,
                ]
              : ["session", "export", started.sessionId]
          const trackedArgs = exportArgs(mode !== "standalone")
          const exports = records.filter(
            (record) => record.args[0] === "session",
          )
          expect(
            exports.map((record) => record.args),
            detail,
          ).toEqual([trackedArgs, trackedArgs, exportArgs(mode === "explicit")])
          const exported = exports.at(-1)
          if (exported === undefined) throw new Error(detail)
          const transcript = parsedExport(exported.stdout)
          expect(transcript.id).toBe(started.sessionId)
          expect(transcript.directory).toBe(current.cwd)
          expect(
            isRecord(transcript.body) &&
              Array.isArray(transcript.body.messages) &&
              transcript.body.messages.some(
                (message: unknown) =>
                  isRecord(message) &&
                  message.type === "assistant" &&
                  message.finish === "length" &&
                  textParts(message.content).includes(TRUNCATED_REPLY),
              ),
            detail,
          ).toBe(true)
          expect(
            isRecord(transcript.body) &&
              Array.isArray(transcript.body.messages) &&
              transcript.body.messages
                .filter(isRecord)
                .filter(
                  (message) =>
                    message.type === "user" &&
                    typeof message.text === "string" &&
                    message.text.endsWith(`\n\n${CURRENT_HANDOFF}`),
                ),
            detail,
          ).toHaveLength(1)
          if (mode !== "standalone") {
            // The pin can return before the background job finishes. Newer
            // OpenCode waits and replays both replies. In either case, the
            // background job must run and its reply remains in history.
            const deadline = performance.now() + 5_000
            const readTexts = async () =>
              (await sessionMessages(current.owned, started.sessionId)).flatMap(
                (message) => textParts(message.content),
              )
            let texts = await readTexts()
            while (
              !texts.includes(BACKGROUND_REPLY) &&
              performance.now() < deadline
            ) {
              await Bun.sleep(50)
              texts = await readTexts()
            }
            expect(texts).toContain(BACKGROUND_REPLY)
          }
          logCase(`prompt-scoped reply (${mode})`, records)
        }
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "start and resume accept production run argv and store the prompt",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const prompt = 'fix "quoted" path'
        for (const mode of ["default", "explicit"] as const) {
          const records: LaunchRecord[] = []
          const started = await runOwned(mode, records, (backend) =>
            backend
              .startTurn({
                cwd: current.cwd,
                prompt,
                model: UNKNOWN_MODEL,
                thinkingLevel: "high",
                timeout: "20 seconds",
              })
              .pipe(Effect.flip),
          )
          expect(started, diagnostic(records, current.secrets)).toBeInstanceOf(
            AgentBackendExitError,
          )
          if (!(started instanceof AgentBackendExitError)) {
            return
          }
          expect(started.exitCode).toBe(1)
          expect(started.message).toBe(MODEL_UNAVAILABLE)
          assertNoArgumentError(
            started.message,
            diagnostic(records, current.secrets),
          )
          expect(started.sessionId).toMatch(/^ses_[A-Za-z0-9]+$/)
          const sessionId = started.sessionId
          if (sessionId === undefined) {
            return
          }
          const session = await sessionBody(current.owned, sessionId)
          const model = modelOf(session)
          expect(model?.providerID).toBe("ready-for-agent-contract")
          expect(model?.id).toBe("no-such-model")
          expect(model?.variant).toBe("high")
          const messages = await sessionMessages(current.owned, sessionId)
          expect(
            messages.some((message) => message.text === prompt),
            JSON.stringify(messages).slice(0, 1200),
          ).toBe(true)
          const run = records.find((record) => record.args.includes("run"))
          expect(run?.args).toContain("--auto")
          expect(run?.args).toContain("--format")
          expect(run?.args).toContain("json")
          expect(run?.args).not.toContain("--")
          if (mode === "explicit") {
            expect(run?.args[0]).toBe("run")
            expect(run?.args[1]).toBe("--server")
          } else {
            expect(run?.args).not.toContain("--server")
          }

          const resumedRecords: LaunchRecord[] = []
          const resumed = await runOwned(mode, resumedRecords, (backend) =>
            backend
              .continueTurn({
                cwd: current.cwd,
                sessionId,
                prompt: "continue the work",
                model: UNKNOWN_MODEL,
                thinkingLevel: null,
                timeout: "20 seconds",
              })
              .pipe(Effect.flip),
          )
          expect(resumed).toBeInstanceOf(AgentBackendExitError)
          if (!(resumed instanceof AgentBackendExitError)) {
            return
          }
          expect(resumed.sessionId).toBe(sessionId)
          expect(resumed.message).toBe(MODEL_UNAVAILABLE)
          assertNoArgumentError(
            resumed.message,
            diagnostic(resumedRecords, current.secrets),
          )
          const after = modelOf(await sessionBody(current.owned, sessionId))
          expect(
            after?.variant === undefined || after?.variant === "default",
          ).toBe(true)
          logCase(`${mode} run`, [...records, ...resumedRecords])
        }
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "stdin delivery preserves newlines and oversized prompts",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const prompt = 'line one "quoted"\nline two'
        const records: LaunchRecord[] = []
        const started = await runOwned("explicit", records, (backend) =>
          backend
            .startTurn({
              cwd: current.cwd,
              prompt,
              model: UNKNOWN_MODEL,
              thinkingLevel: null,
              timeout: "20 seconds",
            })
            .pipe(Effect.flip),
        )
        expect(started).toBeInstanceOf(AgentBackendExitError)
        if (
          !(started instanceof AgentBackendExitError) ||
          started.sessionId === undefined
        ) {
          throw new Error(diagnostic(records, current.secrets))
        }
        expect(started.message).toBe(MODEL_UNAVAILABLE)
        const run = records.find((record) => record.args.includes("run"))
        expect(run?.args).not.toContain("--")
        const messages = await sessionMessages(current.owned, started.sessionId)
        expect(messages.some((message) => message.text === prompt)).toBe(true)

        const oversized = `marker ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
        const oversizedRecords: LaunchRecord[] = []
        const oversizedTurn = await runOwned(
          "explicit",
          oversizedRecords,
          (backend) =>
            backend
              .startTurn({
                cwd: current.cwd,
                prompt: oversized,
                model: UNKNOWN_MODEL,
                thinkingLevel: null,
                timeout: "20 seconds",
              })
              .pipe(Effect.flip),
        )
        expect(oversizedTurn).toBeInstanceOf(AgentBackendExitError)
        if (
          !(oversizedTurn instanceof AgentBackendExitError) ||
          oversizedTurn.sessionId === undefined
        ) {
          throw new Error(diagnostic(oversizedRecords, current.secrets))
        }
        const oversizedRun = oversizedRecords.find((record) =>
          record.args.includes("run"),
        )
        expect(oversizedRun?.args).not.toContain("--")
        const stored = await sessionMessages(
          current.owned,
          oversizedTurn.sessionId,
        )
        expect(stored.some((message) => message.text === oversized)).toBe(true)
        logCase("stdin", [...records, ...oversizedRecords])
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "an oversized non-owned Agent Command is refused before OpenCode starts",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const records: LaunchRecord[] = []
        const refused = await runOwned(
          "non-owned-explicit",
          records,
          (backend) =>
            backend
              .startTurn({
                cwd: current.cwd,
                prompt: "x".repeat(PROMPT_ARGV_BYTE_LIMIT + 1),
                model: UNKNOWN_MODEL,
                thinkingLevel: null,
                command: "review",
                timeout: "20 seconds",
              })
              .pipe(Effect.flip),
        )
        expect(refused).toBeInstanceOf(AgentBackendConfigError)
        if (!(refused instanceof AgentBackendConfigError)) {
          return
        }
        expect(refused.message).toContain("was not started")
        expect(refused.message).toContain(String(PROMPT_ARGV_BYTE_LIMIT))
        expect(records).toEqual([])
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "command turns exercise create, switch, command, wait, and export",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const prompt = 'check "quotes" and spaces'
        for (const mode of ["default", "explicit"] as const) {
          const records: LaunchRecord[] = []
          let created: string | undefined
          const result = await runOwned(mode, records, (backend) =>
            backend
              .startTurn({
                cwd: current.cwd,
                prompt,
                model: UNKNOWN_MODEL,
                thinkingLevel: "high",
                command: "review",
                timeout: "20 seconds",
                onSessionId: (sessionId) =>
                  Effect.sync(() => {
                    created = sessionId
                  }),
              })
              .pipe(Effect.flip),
          )
          expect(created, diagnostic(records, current.secrets)).toMatch(
            /^ses_[A-Za-z0-9]+$/,
          )
          if (created === undefined) {
            return
          }
          const session = await sessionBody(current.owned, created)
          expect(
            isRecord(session.location) ? session.location.directory : undefined,
          ).toBe(current.cwd)
          const messages = await sessionMessages(current.owned, created)
          assertStoredOnce(messages, `Review ${prompt}`)
          const wait = records.find((record) =>
            record.args.some((arg) => arg.includes("/wait")),
          )
          const exported = records.find(
            (record) =>
              record.args[0] === "session" && record.args[1] === "export",
          )
          expect(wait, diagnostic(records, current.secrets)).toBeDefined()
          expect(exported, diagnostic(records, current.secrets)).toBeDefined()
          expect(exported?.stdout).toContain(created)
          assertNoArgumentError(
            `${wait?.stderr ?? ""}\n${exported?.stderr ?? ""}`,
            diagnostic(records, current.secrets),
          )
          if (mode === "explicit") {
            expect(exported?.args.slice(0, 4)).toEqual([
              "session",
              "export",
              "--server",
              current.owned.baseUrl,
            ])
          } else {
            expect(exported?.args).not.toContain("--server")
          }
          expect(result).toBeInstanceOf(AgentBackendMalformedOutputError)

          const continuedRecords: LaunchRecord[] = []
          await runOwned(mode, continuedRecords, (backend) =>
            backend
              .continueTurn({
                cwd: current.cwd,
                sessionId: created ?? "",
                prompt: "follow up",
                model: UNKNOWN_MODEL,
                thinkingLevel: null,
                command: "review",
                timeout: "20 seconds",
              })
              .pipe(Effect.flip),
          )
          const switched = modelOf(await sessionBody(current.owned, created))
          expect(switched?.providerID).toBe("ready-for-agent-contract")
          expect(switched?.id).toBe("no-such-model")
          expect(
            switched?.variant === undefined || switched?.variant === "default",
          ).toBe(true)
          const followUp = await sessionMessages(current.owned, created)
          assertStoredOnce(followUp, "Review follow up")
          const allRecords = [...records, ...continuedRecords]
          expect(
            allRecords
              .flatMap((record) => record.args)
              .filter((arg) => arg === `/api/session/${created}/command`),
          ).toHaveLength(mode === "default" ? 2 : 0)
          logCase(`${mode} command`, allRecords)
        }
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "owned HTTP command start and continuation preserve arguments over 128 KiB",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const cwd = current.otherCwd
        await writeFile(
          join(cwd, "command-location.txt"),
          "the target worktree",
        )
        const argumentsBlock =
          "quotes: \"double\", 'single', \\ and café\nline two\n".repeat(4_000)
        const first = `${argumentsBlock}end of first command`
        const second = `${argumentsBlock}end of continued command`
        expect(Buffer.byteLength(first)).toBeGreaterThan(128 * 1024)
        expect(Buffer.byteLength(second)).toBeGreaterThan(128 * 1024)
        const records: LaunchRecord[] = []
        let created: string | undefined
        const input = {
          cwd,
          model: UNKNOWN_MODEL,
          thinkingLevel: "high",
          command: "/owned-review",
        }
        const started = await runOwned("explicit", records, (backend) =>
          backend
            .startTurn({
              ...input,
              prompt: first,
              onSessionId: (sessionId) =>
                Effect.sync(() => {
                  created = sessionId
                }),
            })
            .pipe(Effect.flip),
        )
        expect(started).toBeInstanceOf(AgentBackendMalformedOutputError)
        if (created === undefined) throw new Error("Missing command session")
        const sessionId = created
        const startedSession = await sessionBody(current.owned, sessionId)
        expect(
          isRecord(startedSession.location)
            ? startedSession.location.directory
            : undefined,
        ).toBe(cwd)
        expect(modelOf(startedSession)).toEqual({
          providerID: "ready-for-agent-contract",
          id: "no-such-model",
          variant: "high",
        })
        const continued = await runOwned("explicit", records, (backend) =>
          backend
            .continueTurn({
              ...input,
              sessionId,
              prompt: second,
              thinkingLevel: "low",
            })
            .pipe(Effect.flip),
        )
        expect(continued).toBeInstanceOf(AgentBackendMalformedOutputError)
        expect(
          modelOf(await sessionBody(current.owned, sessionId))?.variant,
        ).toBe("low")
        const messages = await sessionMessages(current.owned, sessionId)
        const user = messages.filter((message) => message.type === "user")
        expect(user).toHaveLength(2)
        for (const prompt of [first, second]) {
          assertStoredOnce(user, `Review from the target worktree:\n${prompt}`)
        }
        const args = records.flatMap((record) => record.args)
        expect(args).not.toContain(`/api/session/${sessionId}/command`)
        expect(
          args.every((arg) => Buffer.byteLength(arg) < PROMPT_ARGV_BYTE_LIMIT),
        ).toBe(true)
        logCase("oversized owned HTTP command", records)
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "a lost acknowledgement after command acceptance is not replayed",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const records: LaunchRecord[] = []
        const input = {
          cwd: current.cwd,
          model: REPLY_MODEL,
          thinkingLevel: null,
          command: "review",
        }
        const started = await runOwned("explicit", records, (backend) =>
          backend.startTurn({ ...input, prompt: "before the lost response" }),
        )
        expect(started.assistantText).toBe("READY_FOR_AGENT_RESULT: PROCESSED")
        const { sessionId } = started
        const proxy = await openCommandResponseProxy(current.owned, "drop")
        const prompt = 'lost reply for "accepted command"\nsecond line'
        try {
          const error = await runOwned(
            { dedicatedServer: proxy.server },
            records,
            (backend) =>
              backend
                .continueTurn({ ...input, sessionId, prompt })
                .pipe(Effect.flip),
          )
          expect(error).toBeInstanceOf(AgentBackendConfigError)
          expect(error.message).toContain(`session ${sessionId}`)
          expect(error.message).toContain("may have been accepted")
          expect(error.message).not.toContain(prompt)
          expect(proxy.commandRequests).toEqual([
            `/api/session/${sessionId}/command`,
          ])
          expect(proxy.commandResponses).toEqual([204])
          const messages = await sessionMessages(current.owned, sessionId)
          const user = messages.filter((message) => message.type === "user")
          expect(user).toHaveLength(2)
          assertStoredOnce(user, `Review ${prompt}`)
          expect(records.flatMap((record) => record.args)).not.toContain(
            `/api/session/${sessionId}/command`,
          )
          logCase("lost owned HTTP command acknowledgement", records)
        } finally {
          proxy.close()
        }
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "cancelling or timing out an owned command POST interrupts only its session",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const records: LaunchRecord[] = []
        const proxy = await openCommandResponseProxy(current.owned, "hold")
        const readActive = Effect.promise(() => activeSessions(current.owned))
        const awaitActive = (prompt: string, accepted: number) =>
          Effect.gen(function* () {
            while (
              proxy.commandResponses.length < accepted ||
              !current.providerRequests.some((body) => body.includes(prompt))
            ) {
              yield* Effect.sleep("25 millis")
            }
            expect(proxy.commandResponses).toEqual(Array(accepted).fill(204))
            return yield* readActive
          }).pipe(Effect.timeout("8 seconds"))
        const exerciseStops = (backend: OpenCodeBackend) =>
          Effect.gen(function* () {
            const input = {
              cwd: current.cwd,
              model: BLOCKED_MODEL,
              thinkingLevel: null,
              command: "review",
            }
            const decoyPrompt = "unrelated active command"
            const decoy = yield* backend
              .startTurn({ ...input, prompt: decoyPrompt })
              .pipe(Effect.forkChild)
            const [decoyId] = yield* awaitActive(decoyPrompt, 1)
            if (decoyId === undefined) throw new Error("Missing active decoy")

            const cancelPrompt = "cancel this accepted command"
            const cancelled = yield* backend
              .startTurn({ ...input, prompt: cancelPrompt })
              .pipe(Effect.forkChild)
            const active = yield* awaitActive(cancelPrompt, 2)
            const sessionId = active.find((id) => id !== decoyId)
            if (sessionId === undefined)
              throw new Error("Missing active command")
            const assertTargetStopped = (from: number) =>
              Effect.gen(function* () {
                expect(yield* readActive).toEqual([decoyId])
                const interrupts = records
                  .slice(from)
                  .filter((record) =>
                    record.args.some((arg) => arg.endsWith("/interrupt")),
                  )
                expect(interrupts).toHaveLength(1)
                expect(interrupts[0]?.args).toContain(
                  `/api/session/${sessionId}/interrupt`,
                )
                expect(
                  jsonObject(interrupts[0]?.stdout ?? "")?.interrupted,
                ).toBe(true)
              })

            const cancelRecord = records.length
            yield* Fiber.interrupt(cancelled)
            yield* assertTargetStopped(cancelRecord)

            const timeoutPrompt = "time out this accepted continuation"
            const timeoutRecord = records.length
            const timedOut = yield* backend
              .continueTurn({
                ...input,
                sessionId,
                prompt: timeoutPrompt,
                timeout: "4 seconds",
              })
              .pipe(Effect.flip, Effect.forkChild)
            expect(yield* awaitActive(timeoutPrompt, 3)).toContain(sessionId)
            const error = yield* Fiber.join(timedOut)
            expect(error).toBeInstanceOf(AgentBackendTimeoutError)
            if (error instanceof AgentBackendTimeoutError) {
              expect(error.sessionId).toBe(sessionId)
              expect(error.message).toContain(`session ${sessionId}`)
              expect(error.message).toContain("may have been accepted")
              expect(error.message).toContain("did not resend it")
            }
            yield* assertTargetStopped(timeoutRecord)
            expect(
              proxy.commandRequests.filter(
                (path) => path === `/api/session/${sessionId}/command`,
              ),
            ).toHaveLength(2) // Cancelled start and timed-out continuation.
            const history = yield* Effect.promise(() =>
              sessionMessages(current.owned, sessionId),
            )
            assertStoredOnce(history, `Review ${cancelPrompt}`)
            assertStoredOnce(history, `Review ${timeoutPrompt}`)
            yield* Fiber.interrupt(decoy)
          })
        try {
          await runOwned(
            { dedicatedServer: proxy.server },
            records,
            exerciseStops,
          )
          logCase("owned HTTP command interrupt", records)
        } finally {
          proxy.close()
        }
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "aborting a plain prompt stops the active server turn and retains history",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        for (const mode of ["explicit", "default"] as const) {
          const records: LaunchRecord[] = []
          const decoyPrompt = `Unrelated plain prompt (${mode})`
          let sessionId: string | undefined
          await runOwned(mode, records, (backend) =>
            Effect.gen(function* () {
              const pending = new Map<string, PendingImplementStop>()
              const verify = backend.verifyImplementStopped
              if (verify === undefined)
                throw new Error("Missing Implement recovery")
              const options = {
                cwd: current.cwd,
                model: BLOCKED_MODEL,
                thinkingLevel: null,
                trackImplementStop: {
                  started: (target: PendingImplementStop) =>
                    Effect.sync(() => {
                      pending.set(target.sessionId, target)
                    }),
                  stopped: (target: PendingImplementStop) =>
                    Effect.sync(() => {
                      pending.delete(target.sessionId)
                    }),
                },
              }
              const awaitProvider = (prompt: string) =>
                Effect.gen(function* () {
                  const wireText = JSON.stringify(prompt).slice(1, -1)
                  while (
                    !current.providerRequests.some((body) =>
                      body.includes(wireText),
                    )
                  ) {
                    yield* Effect.sleep("25 millis")
                  }
                })
              const decoy = yield* backend
                .startTurn({
                  ...options,
                  prompt: decoyPrompt,
                })
                .pipe(Effect.forkChild)
              yield* awaitProvider(decoyPrompt)
              const [decoyId] = yield* Effect.promise(() =>
                activeSessions(current.owned),
              )
              expect(decoyId).toBeDefined()

              const submitted: string[] = []
              for (const kind of ["fresh", "resumed"] as const) {
                const prompt = `Block the ${kind} plain prompt (${mode})\nKeep the model stream open.`
                let observed = false
                const input = {
                  ...options,
                  prompt,
                  onSessionId: () =>
                    Effect.sync(() => {
                      observed = true
                    }),
                }
                const firstRecord = records.length
                const turn = yield* (
                  sessionId === undefined
                    ? backend.startTurn(input)
                    : backend.continueTurn({ ...input, sessionId })
                ).pipe(Effect.forkChild)
                yield* awaitProvider(prompt)
                const before = yield* Effect.promise(() =>
                  activeSessions(current.owned),
                )
                const target = before.find((id) => id !== decoyId)
                if (target === undefined)
                  throw new Error("Missing active target session")
                const obligation = pending.get(target)
                if (obligation === undefined || "invocation" in obligation)
                  throw new Error("Missing attached stop target")
                expect(obligation.localPid).toBe(current.owned.pid)
                expect(obligation.serverKey).toBe(
                  expectedServerKey(current.owned.baseUrl, current.owned.pid),
                )
                const recoveryInput = { ...obligation, cwd: current.cwd }
                const verification = yield* verify(recoveryInput).pipe(
                  Effect.exit,
                )
                expect(verification._tag).toBe("Failure")
                expect(
                  records
                    .slice(firstRecord)
                    .some((record) =>
                      record.args.some((arg) => arg.endsWith("/interrupt")),
                    ),
                ).toBe(false)
                if (sessionId !== undefined) expect(target).toBe(sessionId)
                sessionId = target
                if (kind === "fresh" && gated.version === gated.baseline) {
                  expect(observed).toBe(false)
                }
                yield* Fiber.interrupt(turn)
                expect(pending.has(target)).toBe(false)
                yield* verify(recoveryInput)
                expect(
                  yield* Effect.promise(() => activeSessions(current.owned)),
                ).toEqual([decoyId])
                const launched = records.slice(firstRecord)
                const identityReads = launched.filter((record) =>
                  record.args.includes("/api/info"),
                )
                if (mode === "explicit") {
                  expect(identityReads.length).toBe(0)
                } else {
                  expect(identityReads[0]?.args).toEqual([
                    "api",
                    "get",
                    "/api/info",
                  ])
                  expect(
                    identityReads
                      .slice(1)
                      .some((record) =>
                        record.args.includes(current.owned.baseUrl),
                      ),
                  ).toBe(true)
                }
                const userMessages = launched.filter((record) =>
                  record.args.some((arg) => arg.includes("/message?")),
                )
                expect(userMessages.length).toBeGreaterThan(0)
                for (const read of userMessages) {
                  expect(
                    read.args.some((arg) => arg.endsWith("&type=user")),
                  ).toBe(true)
                  const data = jsonObject(read.stdout)?.data
                  expect(Array.isArray(data)).toBe(true)
                  if (Array.isArray(data)) {
                    expect(
                      data.every(
                        (message: unknown) =>
                          isRecord(message) && message.type === "user",
                      ),
                    ).toBe(true)
                  }
                }
                const interrupt = launched.find((record) =>
                  record.args.includes(`/api/session/${target}/interrupt`),
                )
                expect(
                  jsonObject(interrupt?.stdout ?? "")?.interrupted,
                  diagnostic(launched, current.secrets),
                ).toBe(true)
                submitted.push(prompt)
                const history = yield* Effect.promise(() =>
                  sessionMessages(current.owned, target),
                )
                for (const text of submitted) assertStoredOnce(history, text)
              }
              yield* Fiber.interrupt(decoy)
              expect(pending.size).toBe(0)
            }).pipe(Effect.timeout("25 seconds")),
          )
          logCase(`${mode} plain prompt interrupt`, records)
        }
        const records: LaunchRecord[] = []
        const standalonePrompt = "Block the private plain prompt"
        await runOwned("standalone", records, (backend) =>
          Effect.gen(function* () {
            let target: PendingImplementStop | undefined
            let confirmed = false
            const turn = yield* backend
              .startTurn({
                cwd: current.cwd,
                model: BLOCKED_MODEL,
                thinkingLevel: null,
                prompt: standalonePrompt,
                trackImplementStop: {
                  started: (pending) =>
                    Effect.sync(() => {
                      target = pending
                    }),
                  stopped: () =>
                    Effect.sync(() => {
                      confirmed = true
                    }),
                },
              })
              .pipe(Effect.forkChild)
            while (
              !current.providerRequests.some((body) =>
                body.includes(standalonePrompt),
              )
            ) {
              yield* Effect.sleep("25 millis")
            }
            expect(
              target,
              "record the private invocation before inference",
            ).toBeDefined()
            const pending = target
            const verifyStopped = backend.verifyImplementStopped
            if (
              pending === undefined ||
              !("invocation" in pending) ||
              verifyStopped === undefined
            ) {
              throw new Error(
                "Private Implement is missing its recovery target",
              )
            }
            expect(confirmed).toBe(false)
            yield* Fiber.interrupt(turn)
            expect(confirmed).toBe(true)
            yield* verifyStopped({ ...pending, cwd: current.cwd })
            while (
              !current.providerCancellations.some((body) =>
                body.includes(standalonePrompt),
              )
            ) {
              yield* Effect.sleep("25 millis")
            }
          }).pipe(Effect.timeout("12 seconds")),
        )
        const run = records.find((record) => record.args[0] === "run")
        expect(run?.args).toContain("--standalone")
        expect(run?.args).not.toContain("--server")
        logCase("private plain prompt interrupt", records)
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "owned Implement identity verifies the original process without a CLI identity read or fallback",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const wrongPassword = crypto.randomUUID()
        const wrongHeaders = openCodeBasicAuthHeaders(wrongPassword)
        const closed = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(null, { status: 500 }),
        })
        const unreachableUrl = closed.url.origin
        await closed.stop(true)
        const records: LaunchRecord[] = []
        const cases = [
          { ...current.owned, headers: wrongHeaders },
          { ...current.owned, baseUrl: unreachableUrl },
        ]
        for (const dedicatedServer of cases) {
          // A working shared registration is present in this mode, but
          // neither the start nor recovery identity path may fall back to it.
          await runOwned({ dedicatedServer }, records, (backend) =>
            Effect.gen(function* () {
              const verify = backend.verifyImplementStopped
              if (verify === undefined)
                throw new Error("Missing Implement recovery")
              const errors = [
                yield* backend
                  .startTurn({
                    cwd: current.cwd,
                    prompt: "must not launch",
                    model: UNKNOWN_MODEL,
                    thinkingLevel: null,
                    trackImplementStop: {
                      started: () => Effect.die("must not record a target"),
                      stopped: () => Effect.die("must not stop a target"),
                    },
                  })
                  .pipe(Effect.flip),
                yield* verify({
                  cwd: current.cwd,
                  sessionId: "ses_owned_identity_contract",
                  serverKey: expectedServerKey(
                    dedicatedServer.baseUrl,
                    current.owned.pid,
                  ),
                  localPid: current.owned.pid,
                }).pipe(Effect.flip),
              ]
              for (const error of errors) {
                const serialized = `${error.message}\n${JSON.stringify(error)}`
                for (const secret of [
                  current.owned.password,
                  ...Object.values(current.owned.headers),
                  wrongPassword,
                  ...Object.values(wrongHeaders),
                ]) {
                  expect(serialized.includes(secret)).toBe(false)
                }
                expect(error).toBeInstanceOf(AgentBackendConfigError)
                expect(error.message).toBe(
                  OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
                )
              }
            }),
          )
        }
        await runOwned("explicit", records, (backend) =>
          Effect.gen(function* () {
            const verify = backend.verifyImplementStopped
            if (verify === undefined)
              throw new Error("Missing Implement recovery")
            // The saved PID must still be live to exercise the comparison,
            // not the separate "original process has exited" shortcut.
            const error = yield* verify({
              cwd: current.cwd,
              sessionId: "ses_owned_identity_contract",
              serverKey: expectedServerKey(current.owned.baseUrl, process.pid),
              localPid: process.pid,
            }).pipe(Effect.flip)
            expect(error.message).toContain(
              "belongs to a different server process",
            )
            expect(records.length).toBe(0)
            yield* verify({
              cwd: current.cwd,
              sessionId: "ses_owned_identity_contract",
              serverKey: expectedServerKey(
                current.owned.baseUrl,
                current.owned.pid,
              ),
              localPid: current.owned.pid,
            })
          }),
        )
        expect(records.map((record) => record.args)).toEqual([
          [
            "api",
            "--server",
            current.owned.baseUrl,
            "get",
            "/api/session/active",
          ],
        ])
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "BER-31 --server before run is rejected on the pin and proven when accepted",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const prompt = "Contract probe"
        const records: LaunchRecord[] = []
        const error = await runOwned(
          "explicit",
          records,
          (backend) =>
            backend
              .startTurn({
                cwd: current.cwd,
                prompt,
                model: UNKNOWN_MODEL,
                thinkingLevel: "high",
                timeout: "20 seconds",
              })
              .pipe(Effect.flip),
          (cliArgs) =>
            cliArgs.includes("run")
              ? moveServerBefore(cliArgs, "run")
              : cliArgs,
        )
        const run = records.find((record) => record.args.includes("run"))
        expect(run, diagnostic(records, current.secrets)).toBeDefined()
        if (run === undefined) {
          return
        }
        const placed = flagBefore(run.args, "run")
        expect(placed.flagAt).toBeLessThan(placed.commandAt)
        expect(placed.url).toBe(current.owned.baseUrl)
        const capability = placementCapability()
        if (capability.kind === "historical-rejection") {
          assertHistoricalServerRejection(
            error,
            UNRECOGNIZED_SERVER_RUN,
            records,
            current.secrets,
          )
          logCase("server-before-run rejected", records)
          return
        }
        assertUnprobedAcceptance(
          capability,
          "run",
          error,
          records,
          current.secrets,
        )
        expect(error, diagnostic(records, current.secrets)).toBeInstanceOf(
          AgentBackendExitError,
        )
        if (!(error instanceof AgentBackendExitError)) {
          return
        }
        expect(error.exitCode).toBe(1)
        expect(error.message).toBe(MODEL_UNAVAILABLE)
        expect(error.sessionId).toMatch(/^ses_[A-Za-z0-9]+$/)
        assertNoArgumentError(
          error.message,
          diagnostic(records, current.secrets),
        )
        const sessionId = error.sessionId
        if (sessionId === undefined) {
          return
        }
        const session = await sessionBody(current.owned, sessionId)
        expect(
          isRecord(session.location) ? session.location.directory : undefined,
        ).toBe(current.cwd)
        const model = modelOf(session)
        expect(model?.providerID).toBe("ready-for-agent-contract")
        expect(model?.id).toBe("no-such-model")
        expect(model?.variant).toBe("high")
        assertStoredOnce(
          await sessionMessages(current.owned, sessionId),
          prompt,
        )
        logCase(
          `server-before-run accepted${unprobedAcceptanceNote(capability)}`,
          records,
        )
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "obsolete run flags still fail with the exact diagnostic",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const failures: string[] = []
        for (const [flag, value, diagnosticText] of [
          ["--dir", "/tmp", "Unrecognized flag: --dir"],
          ["--variant", "high", "Unrecognized flag: --variant"],
          ["--command", "review", "Unrecognized flag: --command"],
        ] as const) {
          const records: LaunchRecord[] = []
          try {
            const error = await runOwned(
              "explicit",
              records,
              (backend) =>
                backend
                  .startTurn({
                    cwd: current.cwd,
                    prompt: "Contract probe",
                    model: UNKNOWN_MODEL,
                    thinkingLevel: "high",
                    timeout: "20 seconds",
                  })
                  .pipe(Effect.flip),
              (cliArgs) =>
                cliArgs.includes("run")
                  ? insertRunFlag(cliArgs, flag, value)
                  : cliArgs,
            )
            expect(error, diagnostic(records, current.secrets)).toBeInstanceOf(
              AgentBackendExitError,
            )
            if (error instanceof AgentBackendExitError) {
              expect(error.message).toContain(diagnosticText)
              expect(error.message).not.toContain("Model unavailable")
              expect(error.message).not.toContain("Could not reach server")
              expect(error.sessionId).toBeUndefined()
            }
          } catch (caught) {
            failures.push(
              `${flag}: ${caught instanceof Error ? caught.message : String(caught)}`,
            )
          }
        }
        expect(failures, failures.join("\n\n")).toEqual([])
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "former models --verbose fails with the exact diagnostic",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const records: LaunchRecord[] = []
        const verbose = await runOwned(
          "explicit",
          records,
          (backend) =>
            backend
              .inspect({ cwd: current.cwd, timeout: "20 seconds" })
              .pipe(Effect.flip),
          (cliArgs) =>
            cliArgs[0] === "api" && cliArgs.includes("/api/model")
              ? ["models", "--verbose"]
              : cliArgs,
        )
        expect(verbose, diagnostic(records, current.secrets)).toBeInstanceOf(
          AgentBackendExitError,
        )
        if (verbose instanceof AgentBackendExitError) {
          expect(verbose.message).toContain(UNRECOGNIZED_VERBOSE)
          expect(verbose.message.match(/Unrecognized flag:/g)).toEqual([
            "Unrecognized flag:",
          ])
          expect(verbose.message).not.toContain("Model unavailable")
        }
        logCase("verbose", records)
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "--server before api is rejected on the pin and proven when accepted",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const prompt = "place the flag"
        const capability = placementCapability()
        if (capability.kind === "historical-rejection") {
          const records: LaunchRecord[] = []
          const error = await runOwned(
            "explicit",
            records,
            (backend) =>
              backend
                .startTurn({
                  cwd: current.cwd,
                  prompt,
                  model: UNKNOWN_MODEL,
                  thinkingLevel: null,
                  command: "review",
                  timeout: "20 seconds",
                })
                .pipe(Effect.flip),
            (cliArgs) =>
              cliArgs[0] === "api" && cliArgs.includes("--server")
                ? moveServerBefore(cliArgs, "api")
                : cliArgs,
          )
          const moved = records.find((record) => record.args.includes("api"))
          expect(moved, diagnostic(records, current.secrets)).toBeDefined()
          if (moved !== undefined) {
            const placed = flagBefore(moved.args, "api")
            expect(placed.flagAt).toBeLessThan(placed.commandAt)
            expect(placed.url).toBe(current.owned.baseUrl)
          }
          assertHistoricalServerRejection(
            error,
            UNRECOGNIZED_SERVER_API,
            records,
            current.secrets,
          )
          logCase("server-before-api rejected", records)
          return
        }
        const accepted = await proveAcceptedCommandPlacement({
          current,
          prompt,
          capability,
          placement: "api",
          mutate: (cliArgs) =>
            cliArgs[0] === "api" && cliArgs.includes("--server")
              ? moveServerBefore(cliArgs, "api")
              : cliArgs,
          assertArgv: (records, url) => {
            const apiCalls = records.filter((record) =>
              record.args.includes("api"),
            )
            expect(apiCalls.length).toBeGreaterThan(0)
            for (const call of apiCalls) {
              const placed = flagBefore(call.args, "api")
              expect(placed.flagAt).toBeLessThan(placed.commandAt)
              expect(placed.url).toBe(url)
            }
            const exported = records.find(
              (record) =>
                record.args[0] === "session" && record.args.includes("export"),
            )
            expect(exported?.args.slice(0, 4)).toEqual([
              "session",
              "export",
              "--server",
              url,
            ])
          },
        })
        logCase(
          `server-before-api accepted${unprobedAcceptanceNote(capability)}`,
          accepted,
        )
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "--server before export is rejected on the pin and proven when accepted",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const prompt = "export placement"
        const capability = placementCapability()
        if (capability.kind === "historical-rejection") {
          const records: LaunchRecord[] = []
          const error = await runOwned(
            "explicit",
            records,
            (backend) =>
              backend
                .startTurn({
                  cwd: current.cwd,
                  prompt,
                  model: UNKNOWN_MODEL,
                  thinkingLevel: null,
                  command: "review",
                  timeout: "20 seconds",
                })
                .pipe(Effect.flip),
            (cliArgs) =>
              cliArgs[0] === "session" && cliArgs.includes("--server")
                ? moveServerBefore(cliArgs, "export")
                : cliArgs,
          )
          const exported = records.find(
            (record) =>
              record.args[0] === "session" && record.args.includes("export"),
          )
          expect(exported, diagnostic(records, current.secrets)).toBeDefined()
          if (exported !== undefined) {
            expect(exported.args.slice(0, 4)).toEqual([
              "session",
              "--server",
              current.owned.baseUrl,
              "export",
            ])
          }
          assertHistoricalServerRejection(
            error,
            UNRECOGNIZED_SERVER_SESSION,
            records,
            current.secrets,
          )
          logCase("server-before-export rejected", records)
          return
        }
        const accepted = await proveAcceptedCommandPlacement({
          current,
          prompt,
          capability,
          placement: "export",
          mutate: (cliArgs) =>
            cliArgs[0] === "session" && cliArgs.includes("--server")
              ? moveServerBefore(cliArgs, "export")
              : cliArgs,
          assertArgv: (records, url) => {
            const apiCalls = records.filter(
              (record) => record.args[0] === "api",
            )
            expect(apiCalls.length).toBeGreaterThan(0)
            for (const call of apiCalls) {
              expect(call.args[1]).toBe("--server")
              expect(call.args[2]).toBe(url)
            }
            const exported = records.find(
              (record) =>
                record.args[0] === "session" && record.args.includes("export"),
            )
            expect(exported?.args.slice(0, 4)).toEqual([
              "session",
              "--server",
              url,
              "export",
            ])
          },
        })
        logCase(
          `server-before-export accepted${unprobedAcceptanceNote(capability)}`,
          accepted,
        )
      })
    },
    CASE_TIMEOUT_MS,
  )
})
