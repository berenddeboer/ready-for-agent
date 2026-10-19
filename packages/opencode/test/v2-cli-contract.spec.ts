/**
 * Real OpenCode V2 contract. Every passing launch goes through a production
 * entry point and the installed binary. See packages/opencode/CLI-CONTRACT.md.
 *
 * Inference-triggering turns stop at the model-unavailable boundary. That
 * proves argument acceptance and session side effects. It is not provider
 * coverage and must not call a cloud model.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Context, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  AgentBackend,
  AgentBackendConfigError,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  PROMPT_ARGV_BYTE_LIMIT,
} from "@ready-for-agent/agent-backend"
import {
  formatGateLog,
  gateOpenCodeContract,
} from "../../../scripts/opencode-contract-gate.ts"
import { Opencode } from "../src/index.js"
import {
  type OwnedOpenCodeServer,
  startOwnedOpenCodeServer,
} from "../src/lib/owned-server.js"
import { readOpenCodeServiceStatus } from "../src/lib/resolve-server-base.js"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const KEYMAXXER_URL = "http://127.0.0.1:9/ber35-cli-contract/mcp"
const UNKNOWN_MODEL = "ready-for-agent-contract/no-such-model"
const MODEL_UNAVAILABLE = `Model unavailable: ${UNKNOWN_MODEL}`
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
  readonly owned: OwnedOpenCodeServer
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
  await mkdir(home, { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(data, { recursive: true })
  await mkdir(state, { recursive: true })
  await mkdir(cache, { recursive: true })
  await mkdir(explicitState, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(otherCwd, { recursive: true })
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
      commands: {
        review: {
          description: "Contract review",
          template: "Review $ARGUMENTS",
        },
      },
    }),
  }
  const owned = await startOwnedOpenCodeServer({
    keymaxxerMcpUrl: KEYMAXXER_URL,
    environment: env,
    cwd,
    readyTimeoutMs: 15_000,
  })
  await registerIsolatedService(env, owned)
  let disposed = false
  return {
    root,
    cwd,
    otherCwd,
    env,
    explicitEnv: { ...env, XDG_STATE_HOME: explicitState },
    owned,
    secrets: [owned.password, KEYMAXXER_URL],
    dispose: async () => {
      if (disposed) {
        return
      }
      disposed = true
      await owned.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const requireFixture = (): Fixture => {
  if (fixture === undefined) {
    throw new Error("CLI contract fixture was not started")
  }
  return fixture
}

const runOwned = <A>(
  mode: "default" | "explicit",
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
              mode === "explicit" ? current.explicitEnv : current.env,
            ...(mode === "explicit"
              ? {
                  dedicatedServer: {
                    baseUrl: current.owned.baseUrl,
                    password: current.owned.password,
                    headers: current.owned.headers,
                    assertAvailable: current.owned.assertAvailable,
                  },
                }
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
    "an oversized Agent Command is refused before OpenCode starts",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const records: LaunchRecord[] = []
        const refused = await runOwned("explicit", records, (backend) =>
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
          expect(
            messages.some((message) => message.text === `Review ${prompt}`),
          ).toBe(true)
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
          expect(
            followUp.some((message) => message.text === "Review follow up"),
          ).toBe(true)
          logCase(`${mode} command`, [...records, ...continuedRecords])
        }
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "aborting a command turn interrupts through the production API",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const records: LaunchRecord[] = []
        let created: string | undefined
        let commandHeld = false
        // Hold the command POST so abort runs while the turn is in flight.
        // The interrupt spawn itself is unmodified production argv.
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const real = yield* ChildProcessSpawner.ChildProcessSpawner
              const spawner = wrapSpawner(real, records)
              const delaying = ChildProcessSpawner.make((command) => {
                if (!ChildProcess.isStandardCommand(command)) {
                  return spawner.spawn(command)
                }
                const binaryAt = opencodeArgIndex(command.args)
                const cliArgs =
                  binaryAt < 0 ? [] : command.args.slice(binaryAt + 1)
                if (cliArgs.some((arg) => arg.endsWith("/command"))) {
                  commandHeld = true
                  return Effect.never
                }
                return spawner.spawn(command)
              })
              yield* Effect.gen(function* () {
                yield* (yield* AgentBackend)
                  .startTurn({
                    cwd: current.cwd,
                    prompt: "interrupt me",
                    model: UNKNOWN_MODEL,
                    thinkingLevel: null,
                    command: "review",
                    timeout: "20 seconds",
                    onSessionId: (sessionId) =>
                      Effect.sync(() => {
                        created = sessionId
                      }),
                  })
                  .pipe(Effect.forkScoped)
                yield* Effect.promise(
                  () =>
                    new Promise<void>((resolve, reject) => {
                      const timer = setTimeout(() => {
                        reject(
                          new Error(
                            "command turn did not reach the command POST",
                          ),
                        )
                      }, 15_000)
                      const poll = () => {
                        if (created !== undefined && commandHeld) {
                          clearTimeout(timer)
                          resolve()
                          return
                        }
                        setTimeout(poll, 50)
                      }
                      poll()
                    }),
                )
              }).pipe(
                Effect.provide(
                  Opencode.layer({
                    keymaxxerMcpUrl: KEYMAXXER_URL,
                    environment: current.explicitEnv,
                    dedicatedServer: {
                      baseUrl: current.owned.baseUrl,
                      password: current.owned.password,
                      headers: current.owned.headers,
                      assertAvailable: current.owned.assertAvailable,
                    },
                    defaultTimeout: "20 seconds",
                    startupTimeout: "8 seconds",
                  }).pipe(
                    Layer.provide(
                      Layer.succeed(
                        ChildProcessSpawner.ChildProcessSpawner,
                        delaying,
                      ),
                    ),
                  ),
                ),
              )
            }),
          ).pipe(Effect.provide(BunServices.layer)),
        )
        expect(created, diagnostic(records, current.secrets)).toBeDefined()
        const interrupt = records.find((record) =>
          record.args.some((arg) => arg.endsWith("/interrupt")),
        )
        expect(interrupt, diagnostic(records, current.secrets)).toBeDefined()
        const body = jsonObject(interrupt?.stdout ?? "")
        expect(typeof body?.interrupted).toBe("boolean")
        assertNoArgumentError(
          `${interrupt?.stdout ?? ""}\n${interrupt?.stderr ?? ""}`,
          diagnostic(records, current.secrets),
        )
        logCase("interrupt", records)
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "BER-31 and other flag mutations fail with the exact diagnostic",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const start = (
          mutate: (cliArgs: ReadonlyArray<string>) => ReadonlyArray<string>,
        ) => {
          const records: LaunchRecord[] = []
          return runOwned(
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
            mutate,
          ).then((error) => ({ error, records }))
        }

        const serverBeforeRun = await start((cliArgs) =>
          cliArgs.includes("run") ? moveServerBefore(cliArgs, "run") : cliArgs,
        )
        expect(serverBeforeRun.error).toBeInstanceOf(AgentBackendExitError)
        if (serverBeforeRun.error instanceof AgentBackendExitError) {
          expect(serverBeforeRun.error.message).toContain(
            UNRECOGNIZED_SERVER_RUN,
          )
          expect(
            serverBeforeRun.error.message.match(/Unrecognized flag:/g),
          ).toEqual(["Unrecognized flag:"])
          expect(serverBeforeRun.error.sessionId).toBeUndefined()
        }

        for (const [flag, value, diagnosticText] of [
          ["--dir", "/tmp", "Unrecognized flag: --dir"],
          ["--variant", "high", "Unrecognized flag: --variant"],
          ["--command", "review", "Unrecognized flag: --command"],
        ] as const) {
          const mutated = await start((cliArgs) =>
            cliArgs.includes("run")
              ? insertRunFlag(cliArgs, flag, value)
              : cliArgs,
          )
          expect(
            mutated.error,
            diagnostic(mutated.records, current.secrets),
          ).toBeInstanceOf(AgentBackendExitError)
          if (mutated.error instanceof AgentBackendExitError) {
            expect(mutated.error.message).toContain(diagnosticText)
            expect(mutated.error.message).not.toContain("Model unavailable")
          }
        }

        const catalogRecords: LaunchRecord[] = []
        const verbose = await runOwned(
          "explicit",
          catalogRecords,
          (backend) =>
            backend
              .inspect({ cwd: current.cwd, timeout: "20 seconds" })
              .pipe(Effect.flip),
          (cliArgs) =>
            cliArgs[0] === "api" && cliArgs.includes("/api/model")
              ? ["models", "--verbose"]
              : cliArgs,
        )
        expect(verbose).toBeInstanceOf(AgentBackendExitError)
        if (verbose instanceof AgentBackendExitError) {
          expect(verbose.message).toContain(UNRECOGNIZED_VERBOSE)
          expect(verbose.message.match(/Unrecognized flag:/g)).toEqual([
            "Unrecognized flag:",
          ])
        }
        logCase("mutations", [...serverBeforeRun.records, ...catalogRecords])
      })
    },
    CASE_TIMEOUT_MS,
  )

  test(
    "misplaced --server on api and export fails with the exact diagnostic",
    async () => {
      await exclusive(async () => {
        const current = requireFixture()
        const records: LaunchRecord[] = []
        const error = await runOwned(
          "explicit",
          records,
          (backend) =>
            backend
              .startTurn({
                cwd: current.cwd,
                prompt: "place the flag",
                model: UNKNOWN_MODEL,
                thinkingLevel: null,
                command: "review",
                timeout: "20 seconds",
              })
              .pipe(Effect.flip),
          (cliArgs) => {
            if (cliArgs[0] === "api" && cliArgs.includes("--server")) {
              return moveServerBefore(cliArgs, "api")
            }
            if (
              cliArgs[0] === "session" &&
              cliArgs[1] === "export" &&
              cliArgs.includes("--server")
            ) {
              return moveServerBefore(cliArgs, "export")
            }
            return cliArgs
          },
        )
        expect(error, diagnostic(records, current.secrets)).toBeInstanceOf(
          AgentBackendExitError,
        )
        if (error instanceof AgentBackendExitError) {
          expect(error.message).toContain(UNRECOGNIZED_SERVER_API)
          expect(error.message).not.toContain("Could not reach server")
        }

        const exportRecords: LaunchRecord[] = []
        const exportError = await runOwned(
          "explicit",
          exportRecords,
          (backend) =>
            backend
              .startTurn({
                cwd: current.cwd,
                prompt: "export placement",
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
        expect(
          exportError,
          diagnostic(exportRecords, current.secrets),
        ).toBeInstanceOf(AgentBackendExitError)
        if (exportError instanceof AgentBackendExitError) {
          expect(exportError.message).toContain(UNRECOGNIZED_SERVER_SESSION)
          expect(exportError.message).not.toContain("Could not reach server")
        }
        logCase("placement", [...records, ...exportRecords])
      })
    },
    CASE_TIMEOUT_MS,
  )
})
