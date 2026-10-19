import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { JumpFailed } from "../jump-error.ts"
import {
  type InteractiveShellInvocation,
  interactiveShellInvocation,
  queuedExecLine,
  renderJumpLauncherScript,
} from "../jump-shell-launch.ts"

export type JumpWindowInput = {
  readonly sessionId: string
  readonly workingDirectory: string
  readonly agentExecutable: string
  readonly agentArguments: readonly string[]
  /** OpenCode V2 model switch, run by the worktree shell before the TUI. */
  readonly modelPinArguments?: readonly string[]
}

const sessionOptionName = "@rfa-session-id"
const agentPaneOptionName = "@rfa-agent"
const agentPaneMarker = "1"
const windowListFormat =
  "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{@rfa-session-id}"
const paneListFormat = "#{pane_id} #{pane_dead} #{@rfa-agent}"

const tmuxArrangeMessage = (detail?: string): string =>
  detail === undefined || detail.length === 0
    ? "tmux could not create and arrange the window"
    : `tmux could not create and arrange the window: ${detail}`

const jumpWindowName = (sessionId: string): string =>
  `rfa:${sessionId.slice(0, 8)}`

const unsupportedShellMessage = (shellPath: string): string =>
  `Jump cannot type an exec command into tmux default-shell '${shellPath}'. Supported shells are bash, zsh, fish, and POSIX sh.`

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
  | {
      readonly kind: "recreate"
      readonly windowId: string
      readonly deadPaneId?: string
    }
  | {
      readonly kind: "foreign"
      readonly sessionName: string
      readonly windowIndex: string
    }

type PreparedLaunch = {
  readonly directory: string
  readonly execLine: string
  readonly shellArguments: readonly string[]
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

const taggedAgentPane = (
  listing: string,
): { readonly paneId: string; readonly dead: boolean } | undefined => {
  for (const line of listing.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    const [paneId, dead, marker] = trimmed.split(/\s+/)
    if (paneId !== undefined && marker === agentPaneMarker) {
      return { paneId, dead: dead === "1" }
    }
  }
  return undefined
}

const executableOnPath = (name: string): string | undefined => {
  const pathEnv = process.env.PATH
  if (pathEnv === undefined) {
    return undefined
  }
  for (const directory of pathEnv.split(":")) {
    if (directory.length === 0) {
      continue
    }
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // This PATH entry does not contain the executable.
    }
  }
  return undefined
}

const writeLaunch = (
  input: JumpWindowInput,
  invocation: InteractiveShellInvocation,
): PreparedLaunch => {
  const directory = mkdtempSync(join(tmpdir(), "rfa-jump-"))
  const scriptPath = join(directory, "launch")
  writeFileSync(
    scriptPath,
    renderJumpLauncherScript({
      executableName: input.agentExecutable,
      arguments: input.agentArguments,
      tmuxExecutable: executableOnPath("tmux") ?? "tmux",
      ...(input.modelPinArguments === undefined
        ? {}
        : { modelPinArguments: input.modelPinArguments }),
    }),
    { mode: 0o700 },
  )
  chmodSync(scriptPath, 0o700)
  return {
    directory,
    execLine: queuedExecLine(invocation.family, scriptPath),
    shellArguments: invocation.arguments,
  }
}

export class Tmux extends Context.Service<
  Tmux,
  {
    readonly tmuxModeSelected: Effect.Effect<boolean>
    readonly createJumpWindow: (
      input: JumpWindowInput,
    ) => Effect.Effect<void, JumpFailed>
  }
>()("ready-for-agent/Tmux") {
  static readonly layer = Layer.effect(
    Tmux,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const tmuxModeSelected = Effect.sync(() => {
        const tmux = process.env.TMUX
        return tmux !== undefined && tmux.length > 0
      })

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

      const discardLaunch = (launch: PreparedLaunch) =>
        Effect.sync(() => {
          rmSync(launch.directory, { recursive: true, force: true })
        })

      const resolveDefaultShell = Effect.fn("Tmux.resolveDefaultShell")(
        function* () {
          const shell = (yield* runTmux([
            "show-options",
            "-Av",
            "default-shell",
          ])).trim()
          if (shell.length === 0) {
            return yield* new JumpFailed({
              message:
                "tmux default-shell is empty; Jump cannot start an interactive shell for the agent pane",
            })
          }
          const invocation = interactiveShellInvocation(shell)
          if (invocation === null) {
            return yield* new JumpFailed({
              message: unsupportedShellMessage(shell),
            })
          }
          yield* Effect.try({
            try: () => {
              accessSync(shell, constants.X_OK)
            },
            catch: () =>
              new JumpFailed({
                message: `tmux default-shell '${shell}' is not executable`,
              }),
          })
          return invocation
        },
      )

      const prepareLaunch = (
        input: JumpWindowInput,
        invocation: InteractiveShellInvocation,
      ) =>
        Effect.try({
          try: () => writeLaunch(input, invocation),
          catch: (cause) =>
            new JumpFailed({
              message: `could not prepare the agent launch command: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
        })

      const queueExec = (paneId: string, execLine: string) =>
        Effect.gen(function* () {
          yield* runTmux(["send-keys", "-t", paneId, "-l", "--", execLine])
          yield* runTmux(["send-keys", "-t", paneId, "Enter"])
        })

      const recreateAgentPane = Effect.fn("Tmux.recreateAgentPane")(function* (
        windowId: string,
        input: JumpWindowInput,
        deadPaneId?: string,
      ) {
        const invocation = yield* resolveDefaultShell()
        const launch = yield* prepareLaunch(input, invocation)
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
          ...launch.shellArguments,
        ]).pipe(Effect.tapError(() => discardLaunch(launch)))
        if (paneId.length === 0) {
          yield* discardLaunch(launch)
          return yield* new JumpFailed({
            message: tmuxArrangeMessage(),
          })
        }
        yield* tagAgentPane(paneId).pipe(
          Effect.tapError(() =>
            Effect.all(
              [
                runTmux(["kill-pane", "-t", paneId]).pipe(Effect.ignore),
                discardLaunch(launch),
              ],
              { discard: true },
            ),
          ),
        )
        // The agent pane closes as soon as the queued process exits. Finish
        // every command that targets it before typing the exec, or a fast
        // agent makes a later select-pane fail with "can't find pane".
        yield* Effect.gen(function* () {
          if (deadPaneId !== undefined) {
            yield* runTmux(["kill-pane", "-t", deadPaneId])
          }
          yield* runTmux(["select-layout", "-t", windowId, "even-horizontal"])
          yield* runTmux(["select-pane", "-t", paneId])
        }).pipe(
          Effect.tapError(() =>
            Effect.all(
              [
                runTmux(["kill-pane", "-t", paneId]).pipe(Effect.ignore),
                discardLaunch(launch),
              ],
              { discard: true },
            ),
          ),
        )
        // Delivered input is not proof the agent is running. The launcher
        // reports a failed launch in the pane; do not delete it after queueing.
        yield* queueExec(paneId, launch.execLine).pipe(
          Effect.tapError(() =>
            runTmux(["kill-pane", "-t", paneId]).pipe(Effect.ignore),
          ),
        )
        yield* runTmux(["select-window", "-t", windowId])
      })

      const createFreshWindow = Effect.fn("Tmux.createFreshWindow")(function* (
        input: JumpWindowInput,
      ) {
        const invocation = yield* resolveDefaultShell()
        const launch = yield* prepareLaunch(input, invocation)
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
          ...launch.shellArguments,
        ]).pipe(Effect.tapError(() => discardLaunch(launch)))
        const [windowId, paneId] = created.split(/\s+/)
        if (windowId === undefined) {
          yield* discardLaunch(launch)
          return yield* new JumpFailed({
            message: tmuxArrangeMessage(),
          })
        }
        if (paneId === undefined) {
          yield* killCreatedWindow(windowId)
          yield* discardLaunch(launch)
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
        }).pipe(
          Effect.tapError(() =>
            Effect.all([killCreatedWindow(windowId), discardLaunch(launch)], {
              discard: true,
            }),
          ),
        )
        // Split and focus first. Typing the exec before select-pane races a
        // fast-exiting agent, which removes the pane tmux still has to focus.
        yield* Effect.gen(function* () {
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
        }).pipe(
          Effect.tapError(() =>
            Effect.all([killCreatedWindow(windowId), discardLaunch(launch)], {
              discard: true,
            }),
          ),
        )
        yield* queueExec(paneId, launch.execLine).pipe(
          Effect.tapError(() => killCreatedWindow(windowId)),
        )
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
        const agent = taggedAgentPane(panes)
        if (agent === undefined) {
          return { kind: "recreate", windowId: current.windowId } as const
        }
        if (agent.dead) {
          return {
            kind: "recreate",
            windowId: current.windowId,
            deadPaneId: agent.paneId,
          } as const
        }
        return {
          kind: "reuse",
          windowId: current.windowId,
          paneId: agent.paneId,
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
            return yield* recreateAgentPane(
              target.windowId,
              input,
              target.deadPaneId,
            )
          case "create":
            return yield* createFreshWindow(input)
          default: {
            const _exhaustive: never = target
            return _exhaustive
          }
        }
      })

      return { tmuxModeSelected, createJumpWindow }
    }),
  )
}
