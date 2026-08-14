import { Effect, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Memory bound for an Agent Turn stderr fold. Only this many characters
 * are retained; older output is dropped. Matches the Install Dependencies
 * diagnostic tail so a chatty CLI cannot grow unbounded.
 */
const CLI_TURN_STDERR_TAIL_LIMIT = 4_000

const appendStderrTail = (
  tail: string,
  chunk: string,
  limit = CLI_TURN_STDERR_TAIL_LIMIT,
): string => {
  const combined = `${tail}${chunk}`
  return combined.length <= limit
    ? combined
    : `…${combined.slice(-(limit - 1))}`
}

/**
 * Drain stderr to EOF, keeping only the most recent `limit` characters.
 *
 * Must be composed into the same concurrent collect as `exitCode` (and
 * stdout) whenever stderr is piped — never leave a piped stream undrained.
 */
export const collectChildStderrTail = (
  handle: ChildProcessHandle,
  limit = CLI_TURN_STDERR_TAIL_LIMIT,
): Effect.Effect<string, PlatformError> =>
  Stream.decodeText(handle.stderr).pipe(
    Stream.runFold(
      () => "",
      (tail, chunk) => appendStderrTail(tail, chunk, limit),
    ),
  )

/**
 * Drain full stdout and a bounded stderr tail concurrently, then read exit.
 *
 * Concurrent drain avoids pipe-buffer deadlock when both streams produce
 * output. Stdout is collected to EOF before relying on process exit so a
 * large catalog cannot be clipped by pipe teardown. Stderr is folded to the
 * same 4000-character tail as Agent Turns so a chatty probe cannot grow
 * unbounded. Used by every readiness probe.
 */
export const collectChildStdoutAndStderr = (
  handle: ChildProcessHandle,
): Effect.Effect<
  {
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  },
  PlatformError
> =>
  Effect.gen(function* () {
    const [stdout, stderr] = yield* Effect.all(
      [
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        collectChildStderrTail(handle),
      ],
      { concurrency: 2 },
    )
    const exitCode = yield* handle.exitCode
    return {
      exitCode: Number(exitCode),
      stdout,
      stderr,
    }
  })
