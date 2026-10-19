/**
 * Real OpenCode jump contract. Runs with `nx run opencode:cli-contract`.
 * Isolated from the operator service. Do not spawn against the shared service.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import {
  AgentBackend,
  AgentBackendExitError,
} from "@ready-for-agent/agent-backend"
import { Opencode } from "../../../packages/opencode/src/index.ts"
import { startOwnedOpenCodeServer } from "../../../packages/opencode/src/lib/owned-server.ts"
import { interactiveResumeCommand } from "./interactive-resume.ts"
import { writeJumpLauncherScript } from "./jump-shell-launch.ts"
import { startInteractiveResume } from "./services/direct-terminal.ts"
import { ExecutablePath } from "./services/executable-path.ts"
import { expect, test } from "bun:test"

const KEYMAXXER_URL = "http://127.0.0.1:9/ber35-jump-contract/mcp"
const UNKNOWN_MODEL = "ready-for-agent-contract/no-such-model"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rejectLauncherFailure = (text: string): void => {
  expect(text).not.toContain("Unrecognized flag:")
  expect(text).not.toContain("ready-for-agent jump:")
  expect(text).not.toContain("could not execute Agent Backend executable")
  expect(text).not.toContain("could not select the Work Item Agent Model")
}

/**
 * The TUI cannot finish in this suite. Still running, with no launcher
 * failure text, is the evidence it started. A quick nonzero exit is not.
 */
const observeStartedTui = async (child: ChildProcess): Promise<void> => {
  let text = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    text += chunk
  })
  child.stderr?.on("data", (chunk: string) => {
    text += chunk
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(child.exitCode, text.slice(0, 400)).toBeNull()
    rejectLauncherFailure(text.slice(0, 800))
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(undefined)
        return
      }
      child.once("close", () => resolve(undefined))
    })
  }
}

test("jump pin and TUI use the production launcher without argument errors", async () => {
  const binary = Bun.which("opencode")
  expect(binary).not.toBeNull()
  if (binary === null) {
    return
  }
  const root = await mkdtemp(join(tmpdir(), "opencode-jump-contract-"))
  const cwd = join(root, 'work "item"')
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: root,
    LANG: "C",
    TERM: "dumb",
    OPENCODE_CONFIG_CONTENT: "{}",
  }
  await mkdir(env.HOME, { recursive: true })
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true })
  await mkdir(env.XDG_DATA_HOME, { recursive: true })
  await mkdir(env.XDG_STATE_HOME, { recursive: true })
  await mkdir(env.XDG_CACHE_HOME, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const owned = await startOwnedOpenCodeServer({
    keymaxxerMcpUrl: KEYMAXXER_URL,
    environment: env,
    cwd,
    readyTimeoutMs: 15_000,
  })
  try {
    const infoResponse = await fetch(`${owned.baseUrl}/api/info`, {
      headers: owned.headers,
      signal: AbortSignal.timeout(5_000),
    })
    const info: unknown = await infoResponse.json()
    if (
      !isRecord(info) ||
      typeof info.version !== "string" ||
      typeof info.pid !== "number"
    ) {
      throw new Error(
        "ephemeral OpenCode server did not return version and pid",
      )
    }
    const stateDir = join(env.XDG_STATE_HOME, "opencode")
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      join(stateDir, "service.json"),
      JSON.stringify({
        id: "ready-for-agent-contract",
        version: info.version,
        url: owned.baseUrl,
        pid: info.pid,
        password: owned.password,
      }),
    )

    const started = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* AgentBackend)
          .startTurn({
            cwd,
            prompt: "jump session",
            model: UNKNOWN_MODEL,
            thinkingLevel: null,
            timeout: "20 seconds",
          })
          .pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          Opencode.layer({
            keymaxxerMcpUrl: KEYMAXXER_URL,
            environment: env,
            defaultTimeout: "20 seconds",
            startupTimeout: "8 seconds",
          }),
        ),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(started).toBeInstanceOf(AgentBackendExitError)
    if (
      !(started instanceof AgentBackendExitError) ||
      started.sessionId === undefined
    ) {
      throw new Error("jump session was not created")
    }
    const sessionId = started.sessionId

    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* AgentBackend).inspect({
          cwd,
          timeout: "20 seconds",
        })
      }).pipe(
        Effect.provide(
          Opencode.layer({
            keymaxxerMcpUrl: KEYMAXXER_URL,
            environment: env,
            defaultTimeout: "20 seconds",
          }),
        ),
        Effect.provide(BunServices.layer),
      ),
    )
    const modelId = catalog.models[0]?.id
    expect(modelId).toBeDefined()
    if (modelId === undefined) {
      return
    }

    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ExecutablePath).resolve("opencode")
      }).pipe(Effect.provide(ExecutablePath.layer)),
    )
    const resume = interactiveResumeCommand({
      backendId: "opencode",
      sessionId,
      workingDirectory: cwd,
      agentModel: modelId,
      thinkingLevel: null,
    })
    expect(resume?.modelPin?.kind).toBe("ready")
    if (resume === null || resume.modelPin?.kind !== "ready") {
      return
    }

    const launched = startInteractiveResume({
      agentExecutable: resolved,
      agentArguments: resume.arguments,
      workingDirectory: cwd,
      modelPinArguments: resume.modelPin.arguments,
      env,
      stdio: "pipe",
    })
    expect(launched.kind).toBe("started")
    if (launched.kind !== "started") {
      throw new Error(launched.stderr)
    }
    await observeStartedTui(launched.child)

    const readModel = async (): Promise<
      Record<string, unknown> | undefined
    > => {
      const sessionResponse = await fetch(
        `${owned.baseUrl}/api/session/${sessionId}`,
        { headers: owned.headers, signal: AbortSignal.timeout(5_000) },
      )
      const sessionBody: unknown = await sessionResponse.json()
      const data = isRecord(sessionBody) ? sessionBody.data : undefined
      return isRecord(data) && isRecord(data.model) ? data.model : undefined
    }
    const model = await readModel()
    const [providerID, ...modelParts] = modelId.split("/")
    expect(model?.providerID).toBe(providerID)
    expect(model?.id).toBe(modelParts.join("/"))

    const scriptPath = writeJumpLauncherScript({
      directory: join(root, "jump-script"),
      executableName: resume.executableName,
      arguments: resume.arguments,
      modelPinArguments: resume.modelPin.arguments,
    })
    const script = spawn(scriptPath, [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    await observeStartedTui(script)
    expect(await readModel()).toEqual(model)
  } finally {
    await owned.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)
