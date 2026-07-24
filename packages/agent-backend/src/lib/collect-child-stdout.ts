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
