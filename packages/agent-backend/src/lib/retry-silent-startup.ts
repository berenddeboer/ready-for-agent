import { Cause, Effect, Option } from "effect"
import type { AgentBackendError } from "./agent-backend.js"
import { AgentBackendStartupTimeoutError } from "./errors.js"
import { findInvocationCleanupFailure } from "./invocation-ownership.js"

/** One replay of a silent known-Session continuation, then fail. */
export const SILENT_KNOWN_SESSION_STARTUP_ATTEMPTS = 2

const cleanupFailureText = (
  cause: Cause.Cause<unknown>,
): string | undefined => {
  const leftover = findInvocationCleanupFailure(cause)
  if (leftover === undefined) {
    return undefined
  }
  return typeof leftover === "string" ? leftover : leftover.message
}

const startupTimeoutOf = (
  cause: Cause.Cause<unknown>,
): AgentBackendStartupTimeoutError | undefined => {
  const error = Cause.findErrorOption(cause)
  if (Option.isNone(error)) {
    return undefined
  }
  return error.value instanceof AgentBackendStartupTimeoutError
    ? error.value
    : undefined
}

/**
 * Replay a known-Session continuation once when the first attempt produces no
 * output within the startup window. Other failures (stdout-then-hang,
 * nonzero exit, malformed output, first turns) pass through unchanged.
 *
 * The first attempt must have already reaped its process tree before this
 * helper retries. Leftover owned processes after SIGKILL are not retryable.
 */
export const retrySilentKnownSessionStartup = <A, R>(
  attempt: () => Effect.Effect<A, AgentBackendError, R>,
  context: {
    readonly sessionId: string
    readonly model: string
    readonly observerLabel?: string
  },
): Effect.Effect<A, AgentBackendError, R> =>
  attempt().pipe(
    Effect.catchCause((cause) => {
      if (cleanupFailureText(cause) !== undefined) {
        return Effect.failCause(cause)
      }
      const first = startupTimeoutOf(cause)
      if (first === undefined) {
        return Effect.failCause(cause)
      }
      return Effect.gen(function* () {
        yield* Effect.logWarning(
          `${context.observerLabel ?? "AgentBackend"} retrying silent known-Session continuation`,
          {
            sessionId: context.sessionId,
            model: context.model,
            cwd: first.cwd,
            startupTimeoutMs: first.startupTimeoutMs,
            failedAttempt: 1,
            nextAttempt: SILENT_KNOWN_SESSION_STARTUP_ATTEMPTS,
          },
        )
        return yield* attempt().pipe(
          Effect.catchCause((secondCause) => {
            const leftover = cleanupFailureText(secondCause)
            const second = startupTimeoutOf(secondCause)
            if (second === undefined) {
              return Effect.failCause(secondCause)
            }
            return new AgentBackendStartupTimeoutError({
              cwd: second.cwd,
              startupTimeoutMs: second.startupTimeoutMs,
              sessionId: context.sessionId,
              model: context.model,
              attemptCount: SILENT_KNOWN_SESSION_STARTUP_ATTEMPTS,
              ...(leftover !== undefined ? { cleanupFailure: leftover } : {}),
            })
          }),
        )
      })
    }),
  )
