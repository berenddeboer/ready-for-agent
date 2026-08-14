import { Deferred, Duration, Effect, Ref, Result, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  findSpawnNotFoundCode,
  formatAgentCliNotFoundRemediation,
} from "./agent-cli-not-found.js"
import {
  collectChildStdout,
  collectChildStdoutAndStderr,
} from "./collect-child-stdout.js"
import {
  type AgentBackendErrorClassification,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendNotInstalledError,
  AgentBackendSessionIdMissingError,
  AgentBackendStartupTimeoutError,
  AgentBackendTimeoutError,
} from "./errors.js"
import { killProcessTree } from "./kill-process-tree.js"
import type { AgentBackendDescriptor, OnSessionId } from "./types.js"

/** Graceful terminate then force-kill bound for the Agent Turn process tree. */
export const DEFAULT_FORCE_KILL_AFTER = Duration.seconds(2)

const capturedCliOutputMessage = (
  stdout: string,
  stderr: string,
): string | undefined => {
  const parts = [stdout, stderr]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts.join("\n") : undefined
}

/**
 * Window from spawn to the first stdout output of an Agent Turn. A CLI that
 * crashes or hangs before emitting anything otherwise burns the whole turn
 * timeout while holding the Work Item.
 */
export const DEFAULT_STARTUP_TIMEOUT = Duration.seconds(60)

export type AgentBackendCliError =
  | AgentBackendExitError
  | AgentBackendTimeoutError
  | AgentBackendStartupTimeoutError
  | AgentBackendSessionIdMissingError
  | AgentBackendMalformedOutputError
  | AgentBackendNotInstalledError
  | PlatformError

export type CliLineEvent = {
  readonly sessionId?: string
  readonly text?: string
  /**
   * When set, the turn finalizes with this assistant text and stops the CLI
   * process tree so later parent-resume output is not folded into the result.
   */
  readonly finalizeText?: string
  /**
   * Set when this line carried a recognizable backend error event (e.g.
   * OpenCode's `error` and `step_finish` stream events). Sticky across the
   * fold: once observed, it rides on AgentBackendExitError if the turn goes
   * on to exit non-zero.
   */
  readonly errorClassification?: AgentBackendErrorClassification
  /**
   * Human-readable reason already parsed from the stream (e.g. Claude
   * `is_error`, Codex `turn.failed`). Sticky like classification: once
   * observed, it becomes AgentBackendExitError.message on a non-zero exit
   * so the adapter does not have to run after the CLI dies.
   */
  readonly errorMessage?: string
}

export type RunCliCaptureInput = {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly backend: AgentBackendDescriptor
  readonly binary: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeout: Duration.Input
  readonly stdin?: "ignore" | Stream.Stream<Uint8Array, PlatformError>
  readonly forceKillAfter?: Duration.Input
  /**
   * When true, return stdout + exitCode even if exit is non-zero instead of
   * failing with AgentBackendExitError. Used by readiness probes that encode
   * auth state in exit status (e.g. `codex login status`).
   */
  readonly allowNonZeroExit?: boolean
  /**
   * When true, pipe and capture stderr (returned as `stderr`). Default ignores
   * stderr so Agent Turn noise does not fill memory. Readiness probes that
   * print status on stderr (Codex `login status`) must opt in.
   */
  readonly captureStderr?: boolean
}

export type RunCliTurnInput = {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly backend: AgentBackendDescriptor
  readonly binary: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeout: Duration.Input
  readonly stdin?: "ignore" | Stream.Stream<Uint8Array, PlatformError>
  readonly forceKillAfter?: Duration.Input
  readonly knownSessionId?: string
  readonly onSessionId?: OnSessionId
  readonly parseLine: (line: string) => CliLineEvent
  readonly observerLabel?: string
  /**
   * Startup-only inactivity bound: when no stdout output arrives within this
   * window of spawn, the process tree is reaped and the turn fails with
   * AgentBackendStartupTimeoutError. Disarmed by the first output, so a
   * long-running tool call mid-turn is never cut short. Defaults to
   * {@link DEFAULT_STARTUP_TIMEOUT}.
   */
  readonly startupTimeout?: Duration.Input
  /**
   * Optional backend-specific side channel that succeeds when the turn has
   * begun without yet writing stdout (e.g. OpenCode session-store activity for
   * a silent parent while a task subagent runs). Completing disarms the
   * startup window the same way the first stdout byte does. Failures are
   * ignored so a broken probe cannot sink the turn. The runner stays
   * backend-neutral: adapters own the observation policy.
   */
  readonly observeStartup?: Effect.Effect<void, unknown>
}

const commandOptions = (input: {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly stdin?: "ignore" | Stream.Stream<Uint8Array, PlatformError>
  readonly forceKillAfter?: Duration.Input
  readonly captureStderr?: boolean
}) => ({
  cwd: input.cwd,
  env: input.env,
  extendEnv: false as const,
  stdin: input.stdin ?? ("ignore" as const),
  // Turns always ignore stderr so a chatty CLI cannot fill an undrained pipe.
  // Capture probes opt in via captureStderr on runCliCapture only.
  stderr: (input.captureStderr === true ? "pipe" : "ignore") as
    | "pipe"
    | "ignore",
  // Own process group on POSIX so group signals reach every CLI worker that
  // stayed in the session. Combined with killProcessTree for setsid stragglers.
  detached: process.platform !== "win32",
  killSignal: "SIGTERM" as const,
  forceKillAfter: input.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER,
})

const mapSpawnError = (
  error: PlatformError,
  input: {
    readonly backend: AgentBackendDescriptor
    readonly binary: string
  },
): PlatformError | AgentBackendNotInstalledError => {
  if (findSpawnNotFoundCode(error) === undefined) {
    return error
  }
  return new AgentBackendNotInstalledError({
    message: formatAgentCliNotFoundRemediation({
      backendLabel: input.backend.label,
      binary: input.binary,
    }),
    backend: input.backend,
    binary: input.binary,
    cause: error,
  })
}

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
 * Run a CLI once, capture full stdout (and optionally stderr), map non-zero
 * exit and timeout to generic Agent Backend errors.
 */
export const runCliCapture = (
  input: RunCliCaptureInput,
): Effect.Effect<
  {
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  },
  | AgentBackendExitError
  | AgentBackendTimeoutError
  | AgentBackendNotInstalledError
  | PlatformError
> =>
  Effect.gen(function* () {
    const spawner = input.spawner
    const timeoutMs = Duration.toMillis(input.timeout)
    const forceKillAfter = input.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER
    const captureStderr = input.captureStderr === true
    const command = ChildProcess.make(
      input.binary,
      [...input.args],
      commandOptions(input),
    )

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(command)
          .pipe(Effect.mapError((error) => mapSpawnError(error, input)))
        // Finalizer runs before Effect's handle cleanup (LIFO): snapshot the
        // tree while the root is still alive, then reap group + descendants.
        yield* Effect.addFinalizer(() =>
          terminateCliTree(handle, forceKillAfter),
        )
        if (captureStderr) {
          return yield* collectChildStdoutAndStderr(handle)
        }
        const captured = yield* collectChildStdout(handle)
        return {
          exitCode: captured.exitCode,
          stdout: captured.stdout,
          stderr: "",
        }
      }),
    ).pipe(
      Effect.timeout(input.timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new AgentBackendTimeoutError({ cwd: input.cwd, timeoutMs }),
        ),
      ),
    )

    if (result.exitCode !== 0 && input.allowNonZeroExit !== true) {
      const message = capturedCliOutputMessage(result.stdout, result.stderr)
      return yield* AgentBackendExitError.new({
        exitCode: result.exitCode,
        cwd: input.cwd,
        ...(message !== undefined ? { message } : {}),
      })
    }

    return result
  })

/**
 * Run a CLI Agent Turn: stream stdout lines, observe early Session ID, fold
 * ordered assistant text, require a Session ID on success.
 *
 * A startup-only inactivity bound fails the turn as soon as it is clear the CLI
 * never started (no stdout output and no successful `observeStartup` within
 * `startupTimeout` of spawn) instead of holding the Work Item for the whole
 * turn timeout. The first stdout output or a successful backend side-channel
 * observation disarms it, because a legitimate mid-turn tool call (build, test
 * suite) or a silent parent stream while a task subagent works can stay quiet
 * for many minutes.
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
    const startupTimeout = input.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT
    const startupTimeoutMs = Duration.toMillis(startupTimeout)
    const knownSessionId = input.knownSessionId
    const seenSessionId = yield* Ref.make(knownSessionId)
    const sessionIdNotified = yield* Ref.make(false)
    const observerLabel = input.observerLabel ?? "AgentBackend"

    const command = ChildProcess.make(
      input.binary,
      [...input.args],
      // Never pipe stderr for turns (undrained stderr can deadlock).
      commandOptions({ ...input, captureStderr: false }),
    )

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(command)
          .pipe(Effect.mapError((error) => mapSpawnError(error, input)))
        yield* Effect.addFinalizer(() =>
          terminateCliTree(handle, forceKillAfter),
        )

        // Disarms the startup bound on the first stdout output rather than the
        // first parsed line, so a CLI that streams one large slow line still
        // counts as started. Optional observeStartup is the same signal via a
        // backend side channel (session store, etc.).
        const started = yield* Deferred.make<void>()
        if (input.observeStartup !== undefined) {
          // Race the probe against `started` so once stdout (or the probe)
          // disarms the window, SQLite/side-channel polling does not continue
          // for the rest of a long turn.
          yield* Effect.race(
            input.observeStartup.pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              // Probe failure must not complete the race (that would exit the
              // fiber without disarming). Fall through to stdout / watchdog.
              Effect.catchCause(() => Effect.never),
            ),
            Deferred.await(started),
          ).pipe(Effect.forkScoped)
        }
        const startupWatchdog = Deferred.await(started).pipe(
          Effect.timeoutOrElse({
            duration: startupTimeout,
            orElse: () =>
              Effect.logWarning(
                `${observerLabel} produced no output within the startup window`,
                { cwd: input.cwd, startupTimeoutMs },
              ).pipe(
                Effect.andThen(
                  new AgentBackendStartupTimeoutError({
                    cwd: input.cwd,
                    startupTimeoutMs,
                    ...(knownSessionId !== undefined
                      ? { sessionId: knownSessionId }
                      : {}),
                  }),
                ),
              ),
          }),
          // Started: never wins the race, so the turn is bounded only by timeout.
          Effect.andThen(Effect.never),
        )

        const collectOutput = Stream.decodeText(handle.stdout).pipe(
          Stream.tap(() => Deferred.succeed(started, undefined)),
          Stream.splitLines,
          Stream.runFoldEffect(
            (): {
              sessionId?: string
              assistantText: string
              finalized: boolean
              errorClassification?: AgentBackendErrorClassification
              errorMessage?: string
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
                const errorClassification =
                  event.errorClassification ?? acc.errorClassification
                const errorMessage = event.errorMessage ?? acc.errorMessage
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
                    ...(errorClassification !== undefined
                      ? { errorClassification }
                      : {}),
                    ...(errorMessage !== undefined ? { errorMessage } : {}),
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
                  ...(errorClassification !== undefined
                    ? { errorClassification }
                    : {}),
                  ...(errorMessage !== undefined ? { errorMessage } : {}),
                }
              }),
          ),
        )

        const [exitOutcome, output] = yield* Effect.all(
          [handle.exitCode.pipe(Effect.result), collectOutput],
          { concurrency: 2 },
        ).pipe(
          // raceFirst so the armed watchdog failure ends the turn immediately
          // instead of waiting for the silent CLI to exit on its own.
          Effect.raceFirst(startupWatchdog),
        )

        return {
          exitOutcome,
          sessionId: output.sessionId,
          assistantText: output.assistantText,
          finalized: output.finalized,
          errorClassification: output.errorClassification,
          errorMessage: output.errorMessage,
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
        return yield* AgentBackendExitError.new({
          exitCode,
          cwd: input.cwd,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(result.errorClassification !== undefined
            ? { classification: result.errorClassification }
            : {}),
          ...(result.errorMessage !== undefined
            ? { message: result.errorMessage }
            : {}),
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
