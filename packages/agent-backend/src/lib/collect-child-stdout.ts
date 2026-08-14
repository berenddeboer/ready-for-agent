import { Effect, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Drain stdout to EOF, then read exit code.
 *
 * Collecting stdout before relying on process exit avoids races where scope
 * finalization or pipe teardown can clip large catalogs near OS pipe capacity.
 */
export const collectChildStdout = (
  handle: ChildProcessHandle,
): Effect.Effect<
  { readonly exitCode: number; readonly stdout: string },
  PlatformError
> =>
  Effect.gen(function* () {
    const stdout = yield* Stream.decodeText(handle.stdout).pipe(Stream.mkString)
    const exitCode = yield* handle.exitCode
    return {
      exitCode: Number(exitCode),
      stdout,
    }
  })

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
 * Drain stdout and stderr concurrently to EOF, then read exit code.
 *
 * Concurrent drain avoids pipe-buffer deadlock when both streams produce
 * output. Used by readiness probes whose CLIs print status on stderr
 * (e.g. `codex login status`).
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
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
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
