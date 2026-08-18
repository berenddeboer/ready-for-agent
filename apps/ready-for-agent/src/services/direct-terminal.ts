import { spawn } from "node:child_process"
import { constants } from "node:os"
import { Context, Effect, Layer } from "effect"
import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"
import { JumpFailed } from "../jump-error.ts"

export type DirectLaunchInput = {
  readonly agentExecutable: string
  readonly agentArguments: readonly string[]
  readonly workingDirectory: string
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

const spawnFailed = (executable: string, error: unknown): JumpFailed =>
  new JumpFailed({
    message: spawnFailedMessage(
      executable,
      error instanceof Error ? error.message : String(error),
    ),
  })

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

        let child: ReturnType<typeof spawn>
        try {
          child = spawn(input.agentExecutable, [...input.agentArguments], {
            cwd: input.workingDirectory,
            env: sanitizeInheritedEnvironment(process.env, {
              stripForgeTokens: false,
            }),
            stdio: "inherit",
            shell: false,
            detached: false,
          })
        } catch (error) {
          finish(Effect.fail(spawnFailed(input.agentExecutable, error)))
          return
        }

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
