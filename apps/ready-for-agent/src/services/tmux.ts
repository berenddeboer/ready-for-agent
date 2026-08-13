import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { JumpFailed } from "../jump-error.ts"

export type JumpWindowInput = {
  readonly workingDirectory: string
  readonly agentExecutable: string
  readonly agentArguments: readonly string[]
}

const tmuxMissingMessage = "jump must be run from inside a tmux session"

const tmuxArrangeMessage = (detail?: string): string =>
  detail === undefined || detail.length === 0
    ? "tmux could not create and arrange the window"
    : `tmux could not create and arrange the window: ${detail}`

export class Tmux extends Context.Service<
  Tmux,
  {
    readonly requireAttachedSession: Effect.Effect<void, JumpFailed>
    readonly createJumpWindow: (
      input: JumpWindowInput,
    ) => Effect.Effect<void, JumpFailed>
  }
>()("ready-for-agent/Tmux") {
  static readonly layer = Layer.effect(
    Tmux,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const requireAttachedSession = Effect.sync(() => {
        const tmux = process.env.TMUX
        return tmux !== undefined && tmux.length > 0
      }).pipe(
        Effect.flatMap((inside) =>
          inside
            ? Effect.void
            : Effect.fail(new JumpFailed({ message: tmuxMissingMessage })),
        ),
      )

      const runTmux = (args: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("tmux", [...args], { stdin: "ignore" }),
            )
            const [exitCode, stdout, stderr] = yield* Effect.all(
              [
                handle.exitCode,
                Stream.decodeText(handle.stdout).pipe(Stream.mkString),
                Stream.decodeText(handle.stderr).pipe(Stream.mkString),
              ],
              { concurrency: 3 },
            )
            if (Number(exitCode) !== 0) {
              const diagnostic = stderr.trim()
              return yield* new JumpFailed({
                message: tmuxArrangeMessage(
                  diagnostic.length === 0 ? `exit ${exitCode}` : diagnostic,
                ),
              })
            }
            return stdout.trim()
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof JumpFailed
              ? error
              : new JumpFailed({
                  message: tmuxArrangeMessage(
                    error instanceof Error ? error.message : String(error),
                  ),
                }),
          ),
        )

      const createJumpWindow = Effect.fn("Tmux.createJumpWindow")(function* (
        input: JumpWindowInput,
      ) {
        const created = yield* runTmux([
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_id} #{pane_id}",
          "-c",
          input.workingDirectory,
          "--",
          input.agentExecutable,
          ...input.agentArguments,
        ])
        const [windowId, paneId] = created.split(/\s+/)
        if (windowId === undefined || paneId === undefined) {
          return yield* new JumpFailed({
            message: tmuxArrangeMessage(),
          })
        }

        yield* runTmux([
          "split-window",
          "-h",
          "-t",
          windowId,
          "-c",
          input.workingDirectory,
        ])
        yield* runTmux(["select-layout", "-t", windowId, "even-horizontal"])
        yield* runTmux(["select-pane", "-t", paneId])
        yield* runTmux(["select-window", "-t", windowId])
      })

      return { requireAttachedSession, createJumpWindow }
    }),
  )
}
