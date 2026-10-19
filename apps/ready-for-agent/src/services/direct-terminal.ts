import { spawn, spawnSync } from "node:child_process"
import { constants } from "node:os"
import { Context, Effect, Layer } from "effect"
import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"
import { JumpFailed } from "../jump-error.ts"

export type DirectLaunchInput = {
  readonly agentExecutable: string
  readonly agentArguments: readonly string[]
  readonly workingDirectory: string
  /** OpenCode V2 model switch. Run before the TUI; failure does not start it. */
  readonly modelPinArguments?: readonly string[]
}

const interactiveTerminalMessage = "jump requires an interactive terminal"

const spawnFailedMessage = (executable: string, detail?: string): string =>
  detail === undefined || detail.length === 0
    ? `could not start Agent Backend executable '${executable}'`
    : `could not start Agent Backend executable '${executable}': ${detail}`

const exitStatusFrom = (
  code: number | null,
  signal: NodeJS.Signals | null,
): number => {
  if (signal !== null) {
    const number = constants.signals[signal]
    if (typeof number === "number") {
      return 128 + number
    }
    return 1
  }
  if (code !== null) {
    return code
  }
  return 1
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g")

const modelPinFailedMessage = (
  status: number | null,
  stderr: string,
): string => {
  const detail = stderr
    .replaceAll(ANSI_COLOR, "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1)
  const statusText = status === null ? "interrupted" : `status ${status}`
  if (detail === undefined) {
    return `could not select the Work Item Agent Model on OpenCode (${statusText})`
  }
  return `could not select the Work Item Agent Model on OpenCode (${statusText}): ${detail}`
}

const spawnFailed = (executable: string, error: unknown): JumpFailed =>
  new JumpFailed({
    message: spawnFailedMessage(
      executable,
      error instanceof Error ? error.message : String(error),
    ),
  })

export type InteractiveResumeLaunch = {
  readonly agentExecutable: string
  readonly agentArguments: readonly string[]
  readonly workingDirectory: string
  readonly modelPinArguments?: readonly string[]
  readonly env: NodeJS.ProcessEnv
  /** TUI stdio. The direct Jump path inherits the terminal. */
  readonly stdio: "inherit" | "pipe"
}

export type InteractiveResumeLaunchResult =
  | {
      readonly kind: "pin-failed"
      readonly status: number | null
      readonly stderr: string
      readonly error?: Error
    }
  | {
      readonly kind: "started"
      readonly child: ReturnType<typeof spawn>
    }

/**
 * Production Jump launch: optional session-model pin, then the TUI.
 * Direct Jump and the CLI contract both call this. Do not rebuild the argv
 * here — callers pass the arguments from `interactiveResumeCommand`.
 */
export const startInteractiveResume = (
  input: InteractiveResumeLaunch,
): InteractiveResumeLaunchResult => {
  const modelPinArguments = input.modelPinArguments
  if (modelPinArguments !== undefined) {
    const pin = spawnSync(input.agentExecutable, [...modelPinArguments], {
      cwd: input.workingDirectory,
      env: input.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })
    if (pin.error !== undefined || pin.status !== 0) {
      return {
        kind: "pin-failed",
        status: pin.status,
        stderr: pin.stderr ?? "",
        ...(pin.error === undefined ? {} : { error: pin.error }),
      }
    }
  }

  try {
    return {
      kind: "started",
      child: spawn(input.agentExecutable, [...input.agentArguments], {
        cwd: input.workingDirectory,
        env: input.env,
        stdio: input.stdio,
        shell: false,
        detached: false,
      }),
    }
  } catch (error) {
    return {
      kind: "pin-failed",
      status: null,
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

const releaseParentTerminalSignals = (): void => {
  process.removeAllListeners("SIGINT")
  process.removeAllListeners("SIGTERM")
  // Empty catchers, not SIG_IGN — posix_spawn is still in flight and would
  // inherit an ignored interrupt.
  process.on("SIGINT", () => {})
  process.on("SIGTERM", () => {})
}

export class DirectTerminal extends Context.Service<
  DirectTerminal,
  {
    readonly requireInteractiveTerminal: Effect.Effect<void, JumpFailed>
    readonly run: (
      input: DirectLaunchInput,
    ) => Effect.Effect<number, JumpFailed>
  }
>()("ready-for-agent/DirectTerminal") {
  static readonly layer = Layer.sync(DirectTerminal, () => {
    const requireInteractiveTerminal = Effect.sync(
      () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    ).pipe(
      Effect.flatMap((interactive) =>
        interactive
          ? Effect.void
          : Effect.fail(
              new JumpFailed({ message: interactiveTerminalMessage }),
            ),
      ),
    )

    const run = Effect.fn("DirectTerminal.run")(function* (
      input: DirectLaunchInput,
    ) {
      const launched = yield* Effect.sync(() =>
        startInteractiveResume({
          agentExecutable: input.agentExecutable,
          agentArguments: input.agentArguments,
          workingDirectory: input.workingDirectory,
          ...(input.modelPinArguments === undefined
            ? {}
            : { modelPinArguments: input.modelPinArguments }),
          env: sanitizeInheritedEnvironment(process.env, {
            stripForgeTokens: false,
          }),
          stdio: "inherit",
        }),
      )
      if (launched.kind === "pin-failed") {
        if (launched.error !== undefined) {
          return yield* spawnFailed(input.agentExecutable, launched.error)
        }
        return yield* new JumpFailed({
          message: modelPinFailedMessage(launched.status, launched.stderr),
        })
      }

      return yield* Effect.callback<number, JumpFailed>((resume) => {
        let started = false
        let failedToStart = false
        let settled = false
        const finish = (effect: Effect.Effect<number, JumpFailed>) => {
          if (settled) {
            return
          }
          settled = true
          resume(effect)
        }

        const child = launched.child

        // Child already inherited the previous disposition. Detach runMain so
        // a process-group interrupt cannot exit Jump while the backend owns
        // the terminal.
        releaseParentTerminalSignals()

        child.once("spawn", () => {
          started = true
        })
        child.once("error", (error) => {
          if (!started) {
            failedToStart = true
            finish(Effect.fail(spawnFailed(input.agentExecutable, error)))
          }
        })
        child.once("close", (code, signal) => {
          if (failedToStart || settled) {
            return
          }
          // Bypass runMain teardown: a prior SIGINT would otherwise force 130.
          process.exit(exitStatusFrom(code, signal))
        })
      }).pipe(Effect.uninterruptible)
    })

    return { requireInteractiveTerminal, run }
  })
}
