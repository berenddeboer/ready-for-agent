import { Effect } from "effect"
import type { AgentBackendError } from "./agent-backend.js"
import { AgentBackendStartupTimeoutError } from "./errors.js"

/** One replay of a silent known-Session continuation, then fail. */
export const SILENT_KNOWN_SESSION_STARTUP_ATTEMPTS = 2

/**
 * Replay a known-Session continuation once when the first attempt produces no
 * output within the startup window. Other failures (stdout-then-hang,
 * nonzero exit, malformed output, first turns) pass through unchanged.
 *
 * The first attempt must have already reaped its process tree before this
 * helper sees AgentBackendStartupTimeoutError.
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
    Effect.catchTag("AgentBackendStartupTimeoutError", (first) =>
      Effect.gen(function* () {
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
          Effect.catchTag(
            "AgentBackendStartupTimeoutError",
            (second) =>
              new AgentBackendStartupTimeoutError({
                cwd: second.cwd,
                startupTimeoutMs: second.startupTimeoutMs,
                sessionId: context.sessionId,
                model: context.model,
                attemptCount: SILENT_KNOWN_SESSION_STARTUP_ATTEMPTS,
              }),
          ),
        )
      }),
    ),
  )
