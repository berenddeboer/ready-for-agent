import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { JumpFailed } from "../jump-error.ts"

export type JumpWindowInput = {
  readonly sessionId: string
  readonly workingDirectory: string
  readonly agentExecutable: string
  readonly agentArguments: readonly string[]
}

const tmuxMissingMessage = "jump must be run from inside a tmux session"

const sessionOptionName = "@rfa-session-id"
const agentPaneOptionName = "@rfa-agent"
const agentPaneMarker = "1"
const windowListFormat =
  "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{@rfa-session-id}"
const paneListFormat = "#{pane_id} #{@rfa-agent}"

const tmuxArrangeMessage = (detail?: string): string =>
  detail === undefined || detail.length === 0
    ? "tmux could not create and arrange the window"
    : `tmux could not create and arrange the window: ${detail}`

const jumpWindowName = (sessionId: string): string =>
  `rfa:${sessionId.slice(0, 8)}`

type TaggedWindow = {
  readonly tmuxSessionId: string
  readonly sessionName: string
  readonly windowId: string
  readonly windowIndex: string
}

type JumpTarget =
  | { readonly kind: "create" }
  | {
      readonly kind: "reuse"
      readonly windowId: string
      readonly paneId: string
    }
  | { readonly kind: "recreate"; readonly windowId: string }
  | {
      readonly kind: "foreign"
      readonly sessionName: string
      readonly windowIndex: string
    }

const parseTaggedWindows = (
  listing: string,
  sessionId: string,
): readonly TaggedWindow[] => {
  const matches: TaggedWindow[] = []
  for (const line of listing.split("\n")) {
    if (line.length === 0) {
      continue
    }
    const [tmuxSessionId, sessionName, windowId, windowIndex, tagged] =
      line.split("\t")
    if (
      tmuxSessionId === undefined ||
      sessionName === undefined ||
      windowId === undefined ||
      windowIndex === undefined ||
      tagged !== sessionId
    ) {
      continue
    }
    matches.push({
      tmuxSessionId,
      sessionName,
      windowId,
      windowIndex,
    })
  }
  return matches
}

const taggedAgentPaneId = (listing: string): string | undefined => {
  for (const line of listing.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    const [paneId, marker] = trimmed.split(/\s+/)
    if (paneId !== undefined && marker === agentPaneMarker) {
      return paneId
    }
  }
  return undefined
}

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

      const killCreatedWindow = (windowId: string) =>
        runTmux(["kill-window", "-t", windowId]).pipe(Effect.ignore)

      const tagAgentPane = (paneId: string) =>
        runTmux([
          "set-option",
          "-p",
          "-t",
          paneId,
          agentPaneOptionName,
          agentPaneMarker,
        ])

      const focusWindow = (windowId: string, paneId: string) =>
        Effect.gen(function* () {
          yield* runTmux(["select-pane", "-t", paneId])
          yield* runTmux(["select-window", "-t", windowId])
        })

      const recreateAgentPane = Effect.fn("Tmux.recreateAgentPane")(function* (
        windowId: string,
        input: JumpWindowInput,
      ) {
        const paneId = yield* runTmux([
          "split-window",
          "-h",
          "-b",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          windowId,
          "-c",
          input.workingDirectory,
          "--",
          input.agentExecutable,
          ...input.agentArguments,
        ])
        if (paneId.length === 0) {
          return yield* new JumpFailed({
            message: tmuxArrangeMessage(),
          })
        }
        yield* tagAgentPane(paneId)
        yield* runTmux(["select-layout", "-t", windowId, "even-horizontal"])
        yield* focusWindow(windowId, paneId)
      })

      const createFreshWindow = Effect.fn("Tmux.createFreshWindow")(function* (
        input: JumpWindowInput,
      ) {
        const created = yield* runTmux([
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_id} #{pane_id}",
          "-n",
          jumpWindowName(input.sessionId),
          "-c",
          input.workingDirectory,
          "--",
          input.agentExecutable,
          ...input.agentArguments,
        ])
        const [windowId, paneId] = created.split(/\s+/)
        if (windowId === undefined) {
          return yield* new JumpFailed({
            message: tmuxArrangeMessage(),
          })
        }
        if (paneId === undefined) {
          yield* killCreatedWindow(windowId)
          return yield* new JumpFailed({
            message: tmuxArrangeMessage(),
          })
        }

        yield* Effect.gen(function* () {
          yield* runTmux([
            "set-option",
            "-w",
            "-t",
            windowId,
            sessionOptionName,
            input.sessionId,
          ])
          yield* tagAgentPane(paneId)
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
        }).pipe(Effect.tapError(() => killCreatedWindow(windowId)))
        yield* runTmux(["select-window", "-t", windowId])
      })

      const resolveJumpTarget = Effect.fn("Tmux.resolveJumpTarget")(function* (
        sessionId: string,
      ) {
        const currentSessionId = yield* runTmux([
          "display-message",
          "-p",
          "#{session_id}",
        ])
        const listing = yield* runTmux([
          "list-windows",
          "-a",
          "-F",
          windowListFormat,
        ])
        const tagged = parseTaggedWindows(listing, sessionId)
        const foreign = tagged.find(
          (window) => window.tmuxSessionId !== currentSessionId,
        )
        if (foreign !== undefined) {
          return {
            kind: "foreign",
            sessionName: foreign.sessionName,
            windowIndex: foreign.windowIndex,
          } as const
        }
        const current = tagged[0]
        if (current === undefined) {
          return { kind: "create" } as const
        }
        const panes = yield* runTmux([
          "list-panes",
          "-t",
          current.windowId,
          "-F",
          paneListFormat,
        ])
        const paneId = taggedAgentPaneId(panes)
        if (paneId === undefined) {
          return { kind: "recreate", windowId: current.windowId } as const
        }
        return {
          kind: "reuse",
          windowId: current.windowId,
          paneId,
        } as const
      })

      const createJumpWindow = Effect.fn("Tmux.createJumpWindow")(function* (
        input: JumpWindowInput,
      ) {
        const target: JumpTarget = yield* resolveJumpTarget(input.sessionId)
        switch (target.kind) {
          case "foreign":
            return yield* new JumpFailed({
              message: `Session already open in tmux session '${target.sessionName}' window ${target.windowIndex}`,
            })
          case "reuse":
            return yield* focusWindow(target.windowId, target.paneId)
          case "recreate":
            return yield* recreateAgentPane(target.windowId, input)
          case "create":
            return yield* createFreshWindow(input)
          default: {
            const _exhaustive: never = target
            return _exhaustive
          }
        }
      })

      return { requireAttachedSession, createJumpWindow }
    }),
  )
}
