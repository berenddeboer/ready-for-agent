import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  AgentBackend,
  AgentBackendExitError,
} from "@ready-for-agent/agent-backend"
import { Opencode } from "../src/index.js"
import { buildCommandApiArgs, buildRunArgs } from "../src/lib/build-args.js"
import {
  type OwnedOpenCodeServer,
  startOwnedOpenCodeServer,
} from "../src/lib/owned-server.js"
import { describe, expect, it } from "bun:test"

const opencode = spawnSync("opencode", ["--version"], { encoding: "utf8" })
const versionText = `${opencode.stdout ?? ""}\n${opencode.stderr ?? ""}`
const installedV2 =
  opencode.status === 0 && /(?:^|\s)v?2\.\d+\.\d+/.test(versionText)

/** Flags only. Tokens after `--` are message text, so a probe flag must precede them. */
const flagsOnly = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const end = args.indexOf("--")
  return end === -1 ? args : args.slice(0, end)
}

const rejectBeforeInference = (args: ReadonlyArray<string>) =>
  spawnSync("opencode", [...flagsOnly(args), "--bogus"], {
    encoding: "utf8",
    timeout: 10_000,
  })

/**
 * Supplemental parser probe. It does not launch through the owned-server
 * wrapper. The contract below does.
 */
describe.skipIf(opencode.status !== 0)(
  "installed OpenCode V2 argument contract",
  () => {
    it("accepts generated start and resume argv and rejects obsolete flags before inference", () => {
      expect(installedV2).toBe(true)
      const start = buildRunArgs({
        prompt: "fix the bug",
        model: "provider/model",
        thinkingLevel: "high",
      })
      const resume = buildRunArgs({
        prompt: "continue",
        model: "provider/model",
        thinkingLevel: null,
        sessionId: "ses_contract",
      })
      const command = buildCommandApiArgs({
        sessionId: "ses_contract",
        command: "/review",
        prompt: "Review the diff",
        directory: "/tmp/work-item",
      })

      for (const args of [start, resume, command]) {
        expect(flagsOnly(args)).not.toContain("--")
        const result = rejectBeforeInference(args)
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        expect(result.status).toBe(1)
        expect(output).toContain("Unrecognized flag: --bogus")
        expect(output).not.toContain("Unrecognized flag: --dir")
        expect(output).not.toContain("Unrecognized flag: --variant")
        expect(output).not.toContain("Unrecognized flag: --command")
      }

      const obsolete = spawnSync(
        "opencode",
        ["run", "--dir", "/tmp", "--variant", "high"],
        { encoding: "utf8", timeout: 10_000 },
      )
      const obsoleteOutput = `${obsolete.stdout ?? ""}\n${obsolete.stderr ?? ""}`
      expect(obsolete.status).toBe(1)
      expect(obsoleteOutput).toContain("Unrecognized flag: --dir")
      expect(obsoleteOutput).toContain("Unrecognized flag: --variant")
    })
  },
)

const MODEL = "ready-for-agent-contract/no-such-model"
const MODEL_UNAVAILABLE = `Model unavailable: ${MODEL}`
const UNRECOGNIZED_SERVER_FLAG =
  "Unrecognized flag: --server in command opencode run"
const KEYMAXXER_URL = "http://127.0.0.1:9/ber34-owned-probe/mcp"

/**
 * BER-31 placed `--server` before `run`. Rewrite only that CLI argv on an
 * already composed production launch, leaving the real launcher in place.
 */
const moveServerFlagBeforeRun = (
  cliArgs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const runAt = cliArgs.indexOf("run")
  const flagAt = cliArgs.indexOf("--server")
  const url = cliArgs[flagAt + 1]
  if (runAt < 0 || flagAt < 0 || url === undefined || url.startsWith("-")) {
    throw new Error("production run argv is missing run or --server")
  }
  if (flagAt < runAt) {
    throw new Error("production already placed --server before run")
  }
  const without = [...cliArgs.slice(0, flagAt), ...cliArgs.slice(flagAt + 2)]
  const runAtNow = without.indexOf("run")
  return [
    ...without.slice(0, runAtNow),
    "--server",
    url,
    ...without.slice(runAtNow),
  ]
}

const mutateLaunchedRun = (
  real: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return real.spawn(command)
    }
    const binaryAt = command.args.findIndex(
      (arg) => arg === "opencode" || arg.endsWith("/opencode"),
    )
    if (binaryAt === -1) {
      return Effect.die(
        new Error("BER-31 mutation could not find the opencode executable"),
      )
    }
    const cliArgs = command.args.slice(binaryAt + 1)
    if (!cliArgs.includes("run")) {
      return real.spawn(command)
    }
    const args = [
      ...command.args.slice(0, binaryAt + 1),
      ...moveServerFlagBeforeRun(cliArgs),
    ]
    return real.spawn(ChildProcess.make(command.command, args, command.options))
  })

const withIsolatedServer = async <A>(
  use: (
    owned: OwnedOpenCodeServer,
    cwd: string,
    environment: Record<string, string>,
  ) => Promise<A>,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "opencode-run-contract-"))
  const home = join(root, "home")
  const config = join(root, "config")
  const data = join(root, "data")
  const state = join(root, "state")
  const cache = join(root, "cache")
  const cwd = join(root, "work")
  await mkdir(home, { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(data, { recursive: true })
  await mkdir(state, { recursive: true })
  await mkdir(cache, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    TMPDIR: root,
    LANG: "C",
    TERM: "dumb",
    OPENCODE_CONFIG_CONTENT: "{}",
  }
  let owned: OwnedOpenCodeServer | undefined
  try {
    owned = await startOwnedOpenCodeServer({
      keymaxxerMcpUrl: KEYMAXXER_URL,
      environment,
      cwd,
      readyTimeoutMs: 15_000,
    })
    return await use(owned, cwd, environment)
  } finally {
    await owned?.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

type OpenCodeBackend = Context.Service.Shape<typeof AgentBackend>

const runOwned = <A, E>(
  owned: OwnedOpenCodeServer,
  environment: Record<string, string>,
  mutateServerFlag: boolean,
  use: (backend: OpenCodeBackend) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const spawner = mutateServerFlag ? mutateLaunchedRun(real) : real
    return yield* Effect.gen(function* () {
      return yield* use(yield* AgentBackend)
    }).pipe(
      Effect.provide(
        Opencode.layer({
          keymaxxerMcpUrl: KEYMAXXER_URL,
          environment,
          dedicatedServer: {
            baseUrl: owned.baseUrl,
            password: owned.password,
            headers: owned.headers,
            assertAvailable: owned.assertAvailable,
          },
          defaultTimeout: "20 seconds",
          startupTimeout: "10 seconds",
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      ),
    )
  }).pipe(Effect.provide(BunServices.layer))

const expectOwnedSession = async (
  owned: OwnedOpenCodeServer,
  sessionId: string,
) => {
  const response = await fetch(`${owned.baseUrl}/api/session/${sessionId}`, {
    headers: owned.headers,
    signal: AbortSignal.timeout(5_000),
  })
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).toContain(sessionId)
  expect(body).not.toContain(owned.password)
}

describe.skipIf(opencode.status !== 0)(
  "owned-server run flag placement",
  () => {
    it("starts and resumes through the owned server without an argument error", async () => {
      expect(installedV2).toBe(true)
      await withIsolatedServer(async (owned, cwd, environment) => {
        const started = await Effect.runPromise(
          runOwned(owned, environment, false, (backend) =>
            backend.startTurn({
              cwd,
              prompt: "Contract probe",
              model: MODEL,
              thinkingLevel: "high",
              timeout: "20 seconds",
            }),
          ).pipe(Effect.flip),
        )
        expect(started).toBeInstanceOf(AgentBackendExitError)
        if (!(started instanceof AgentBackendExitError)) {
          return
        }
        expect(started.exitCode).toBe(1)
        expect(started.message).toBe(MODEL_UNAVAILABLE)
        expect(started.message).not.toContain("Unrecognized flag:")
        expect(started.message).not.toContain("Invalid value for flag")
        expect(started.sessionId).toMatch(/^ses_[A-Za-z0-9]+$/)
        const sessionId = started.sessionId
        if (sessionId === undefined) {
          return
        }
        await expectOwnedSession(owned, sessionId)

        const resumed = await Effect.runPromise(
          runOwned(owned, environment, false, (backend) =>
            backend.continueTurn({
              cwd,
              sessionId,
              prompt: "continue the work",
              model: MODEL,
              thinkingLevel: null,
              timeout: "20 seconds",
            }),
          ).pipe(Effect.flip),
        )
        expect(resumed).toBeInstanceOf(AgentBackendExitError)
        if (!(resumed instanceof AgentBackendExitError)) {
          return
        }
        expect(resumed.exitCode).toBe(1)
        expect(resumed.sessionId).toBe(sessionId)
        expect(resumed.message).toBe(MODEL_UNAVAILABLE)
        expect(resumed.message).not.toContain("Unrecognized flag:")
        expect(resumed.message).not.toContain("Invalid value for flag")
        await expectOwnedSession(owned, sessionId)
      })
    }, 45_000)

    it("reports the BER-31 unrecognized --server flag when that flag precedes run", async () => {
      expect(installedV2).toBe(true)
      await withIsolatedServer(async (owned, cwd, environment) => {
        const error = await Effect.runPromise(
          runOwned(owned, environment, true, (backend) =>
            backend.startTurn({
              cwd,
              prompt: "Contract probe",
              model: MODEL,
              thinkingLevel: "high",
              timeout: "20 seconds",
            }),
          ).pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (!(error instanceof AgentBackendExitError)) {
          return
        }
        expect(error.exitCode).toBe(1)
        expect(error.sessionId).toBeUndefined()
        expect(error.message).toContain(UNRECOGNIZED_SERVER_FLAG)
        expect(error.message.match(/Unrecognized flag:/g)).toEqual([
          "Unrecognized flag:",
        ])
        expect(error.message).not.toContain("Invalid value for flag")
        expect(error.message).not.toContain("Model unavailable")
      })
    }, 45_000)
  },
)
