import { Duration, Effect, Ref, Result, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { collectChildStdout } from "./collect-child-stdout.js"
import {
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
} from "./errors.js"
import { killProcessTree } from "./kill-process-tree.js"
import type { OnSessionId } from "./types.js"

/** Graceful terminate then force-kill bound for the Agent Turn process tree. */
export const DEFAULT_FORCE_KILL_AFTER = Duration.seconds(2)

export type AgentBackendCliError =
  | AgentBackendExitError
  | AgentBackendTimeoutError
  | AgentBackendSessionIdMissingError
  | AgentBackendMalformedOutputError
  | PlatformError

export type CliLineEvent = {
  readonly sessionId?: string
  readonly text?: string
  /**
   * When set, the turn finalizes with this assistant text and stops the CLI
   * process tree so later parent-resume output is not folded into the result.
   */
  readonly finalizeText?: string
}

export type RunCliCaptureInput = {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly binary: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeout: Duration.Input
  readonly stdin?: "ignore" | Stream.Stream<Uint8Array, PlatformError>
  readonly forceKillAfter?: Duration.Input
}

export type RunCliTurnInput = RunCliCaptureInput & {
  readonly knownSessionId?: string
  readonly onSessionId?: OnSessionId
  readonly parseLine: (line: string) => CliLineEvent
  readonly observerLabel?: string
}

const commandOptions = (input: RunCliCaptureInput) => ({
  cwd: input.cwd,
  env: input.env,
  extendEnv: false as const,
  stdin: input.stdin ?? ("ignore" as const),
  stderr: "ignore" as const,
  // Own process group on POSIX so group signals reach every CLI worker that
  // stayed in the session. Combined with killProcessTree for setsid stragglers.
  detached: process.platform !== "win32",
  killSignal: "SIGTERM" as const,
  forceKillAfter: input.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER,
})

/**
 * Terminate the harness-spawned CLI and every process it started.
 *
 * Snapshots the PPID tree then SIGTERM→SIGKILL escalates across the process
 * group and known descendants. Runs as a scope finalizer (timeout / interrupt)
 * and on the finalizeText early-exit path.
 *
 * `killProcessTree` always escalates to SIGKILL via `Effect.ensuring`, so an
 * outer bound only caps the interruptible wait loop — hard kill still runs.
 * The ensuring body is uninterruptible: it SIGKILLs the starttime-checked
 * snapshot and, only while the original root is still ours, a short PPID
 * re-scan for late-spawned children.
 */
const terminateCliTree = (
  handle: ChildProcessHandle,
  forceKillAfter: Duration.Input,
): Effect.Effect<void> =>
  killProcessTree(Number(handle.pid), { forceKillAfter }).pipe(
    // Bounds the wait loop if it hangs; cannot cut short the ensuring escalate.
    Effect.timeout(Duration.millis(Duration.toMillis(forceKillAfter) + 1_000)),
    Effect.ignore,
  )

/**
 * Run a CLI once, capture full stdout, map non-zero exit and timeout to
 * generic Agent Backend errors.
 */
export const runCliCapture = (
  input: RunCliCaptureInput,
): Effect.Effect<
  { readonly exitCode: number; readonly stdout: string },
  AgentBackendExitError | AgentBackendTimeoutError | PlatformError
> =>
  Effect.gen(function* () {
    const spawner = input.spawner
    const timeoutMs = Duration.toMillis(input.timeout)
    const forceKillAfter = input.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER
    const command = ChildProcess.make(
      input.binary,
      [...input.args],
      commandOptions(input),
    )

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        // Finalizer runs before Effect's handle cleanup (LIFO): snapshot the
        // tree while the root is still alive, then reap group + descendants.
        yield* Effect.addFinalizer(() =>
          terminateCliTree(handle, forceKillAfter),
        )
        return yield* collectChildStdout(handle)
      }),
    ).pipe(
      Effect.timeout(input.timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new AgentBackendTimeoutError({ cwd: input.cwd, timeoutMs }),
        ),
      ),
    )

    if (result.exitCode !== 0) {
      return yield* new AgentBackendExitError({
        exitCode: result.exitCode,
        cwd: input.cwd,
      })
    }

    return result
  })

/**
 * Run a CLI Agent Turn: stream stdout lines, observe early Session ID, fold
 * ordered assistant text, require a Session ID on success.
 */
export const runCliTurn = (
  input: RunCliTurnInput,
): Effect.Effect<
  { readonly sessionId: string; readonly assistantText: string },
  AgentBackendCliError
> =>
  Effect.gen(function* () {
    const spawner = input.spawner
    const timeoutMs = Duration.toMillis(input.timeout)
    const forceKillAfter = input.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER
    const knownSessionId = input.knownSessionId
    const seenSessionId = yield* Ref.make(knownSessionId)
    const sessionIdNotified = yield* Ref.make(false)
    const observerLabel = input.observerLabel ?? "AgentBackend"

    const command = ChildProcess.make(
      input.binary,
      [...input.args],
      commandOptions(input),
    )

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        yield* Effect.addFinalizer(() =>
          terminateCliTree(handle, forceKillAfter),
        )

        const collectOutput = Stream.decodeText(handle.stdout).pipe(
          Stream.splitLines,
          Stream.runFoldEffect(
            (): {
              sessionId?: string
              assistantText: string
              finalized: boolean
            } => ({
              assistantText: "",
              finalized: false,
            }),
            (acc, line) =>
              Effect.gen(function* () {
                if (acc.finalized) {
                  return acc
                }

                const event = input.parseLine(line)
                const sessionId = event.sessionId ?? acc.sessionId
                if (event.sessionId !== undefined) {
                  yield* Ref.set(seenSessionId, event.sessionId)
                  const alreadyNotified = yield* Ref.getAndSet(
                    sessionIdNotified,
                    true,
                  )
                  if (!alreadyNotified && input.onSessionId !== undefined) {
                    yield* input.onSessionId(event.sessionId).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning(
                          `${observerLabel} onSessionId observer failed`,
                          { sessionId: event.sessionId, error },
                        ),
                      ),
                      Effect.forkDetach({ startImmediately: true }),
                    )
                  }
                }

                if (event.finalizeText !== undefined) {
                  const running = yield* handle.isRunning
                  if (running) {
                    // Single authoritative tree kill; join exit without a
                    // second full SIGTERM→SIGKILL budget on the direct child.
                    yield* terminateCliTree(handle, forceKillAfter)
                    yield* handle.exitCode.pipe(
                      Effect.timeout(
                        Duration.millis(
                          Duration.toMillis(forceKillAfter) + 500,
                        ),
                      ),
                      Effect.ignore,
                    )
                  }
                  return {
                    sessionId,
                    assistantText: event.finalizeText,
                    finalized: true,
                  }
                }

                return {
                  sessionId,
                  assistantText:
                    event.text === undefined
                      ? acc.assistantText
                      : acc.assistantText.length === 0
                        ? event.text
                        : `${acc.assistantText}\n${event.text}`,
                  finalized: false,
                }
              }),
          ),
        )

        const [exitOutcome, output] = yield* Effect.all(
          [handle.exitCode.pipe(Effect.result), collectOutput],
          { concurrency: 2 },
        )

        return {
          exitOutcome,
          sessionId: output.sessionId,
          assistantText: output.assistantText,
          finalized: output.finalized,
        }
      }),
    ).pipe(
      Effect.timeout(input.timeout),
      Effect.catchTag("TimeoutError", () =>
        Ref.get(seenSessionId).pipe(
          Effect.flatMap(
            (sessionId) =>
              new AgentBackendTimeoutError({
                cwd: input.cwd,
                timeoutMs,
                ...(sessionId !== undefined ? { sessionId } : {}),
              }),
          ),
        ),
      ),
    )

    // Intentional kill after finalize yields a signalled/non-zero exit; success.
    if (!result.finalized) {
      if (Result.isFailure(result.exitOutcome)) {
        return yield* result.exitOutcome.failure
      }
      const exitCode = Number(result.exitOutcome.success)
      if (exitCode !== 0) {
        const sessionId = result.sessionId ?? knownSessionId
        return yield* new AgentBackendExitError({
          exitCode,
          cwd: input.cwd,
          ...(sessionId !== undefined ? { sessionId } : {}),
        })
      }
    }

    const sessionId = result.sessionId ?? knownSessionId
    if (sessionId === undefined) {
      return yield* new AgentBackendSessionIdMissingError({ cwd: input.cwd })
    }

    return {
      sessionId,
      assistantText: result.assistantText,
    }
  })

export const malformedOutput = (
  cwd: string,
  stdout: string,
): AgentBackendMalformedOutputError =>
  new AgentBackendMalformedOutputError({
    cwd,
    byteLength: Buffer.byteLength(stdout, "utf8"),
  })
