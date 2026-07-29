import { type QueryClient, isCancelledError } from "@tanstack/react-query"
import { openPullRequestCountsQueryKey } from "./refresh-open-pull-request-count-live.js"
import {
  REPOSITORY_SSE_STALE_AFTER_MS,
  type RepositoryLiveStreamDisconnectReason,
  type RepositoryLiveStreamEnd,
  RepositorySubscriptionStaleError,
  streamRepositoryChanges,
} from "./repository-live.js"

/**
 * Grace period before the live-updates warning is shown while the Repository
 * subscription is connecting, reconnecting, or otherwise not transport-healthy.
 * Matches the historical 10s banner delay.
 */
export const LIVE_UPDATES_WARNING_GRACE_MS = 10_000

export const LIVE_UPDATES_UNAVAILABLE_MESSAGE =
  "Live updates are unavailable. Repository information may be out of date."

/** Cap for exponential catch-up retry backoff after repeated failures. */
export const CATCH_UP_RETRY_MAX_DELAY_MS = 30_000

/**
 * Presentation for the Repository live-updates warning. Transport health only:
 * slow or failed catch-up / Pull Request counts never set `unavailable`.
 */
export const liveUpdatesWarningPresentation = (
  unavailable: boolean,
): { readonly message: string } | null =>
  unavailable ? { message: LIVE_UPDATES_UNAVAILABLE_MESSAGE } : null

export type RepositoryMembershipLiveQuery = {
  readonly queryKey: readonly unknown[]
  readonly queryFn: () => Promise<unknown>
}

/**
 * Actionable Repository-subscription diagnostics. Never includes secret values
 * or the Keymaxxer Sidecar capability URL.
 */
export type RepositoryLiveDiagnostic =
  | {
      readonly event: "connect"
      readonly generation: number
    }
  | {
      readonly event: "disconnect"
      readonly generation: number
      readonly reason: RepositoryLiveStreamDisconnectReason
      readonly heartbeatAgeMs: number | null
    }
  | {
      readonly event: "reconnect"
      readonly generation: number
      readonly reason: "retry"
    }
  | {
      readonly event: "stale"
      readonly generation: number
      readonly heartbeatAgeMs: number
    }
  | {
      readonly event: "catch_up_failure"
      readonly generation: number
      readonly message: string
    }

export type RepositoryMembershipLiveStream = (input: {
  signal: AbortSignal
  onConnected: () => void | Promise<void>
  onChange: () => void | Promise<void>
  onActivity?: (info: { readonly kind: "chunk" | "comment" | "next" }) => void
  staleAfterMs?: number
}) => Promise<RepositoryLiveStreamEnd | undefined>

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error as { name: string }).name === "AbortError"

/**
 * Follows the Repository-membership GraphQL SSE subscription with transport
 * health reported independently of authoritative catch-up.
 *
 * - A successful SSE response establishes transport health immediately.
 * - Catch-up is single-flight, generation-scoped, and cannot terminate a
 *   healthy stream when it is slow, canceled, or fails.
 * - Dedicated open-PR counts are fire-and-forget and never affect the warning.
 * - Missing heartbeat/event activity beyond {@link REPOSITORY_SSE_STALE_AFTER_MS}
 *   marks the connection stale and reconnects once for that generation.
 * - A newer reconnect generation supersedes stale callbacks from older ones.
 * - Sustained transport disconnection surfaces the live-updates warning after
 *   {@link LIVE_UPDATES_WARNING_GRACE_MS}; recovery clears it promptly.
 */
export const followRepositoryMembershipLive = async ({
  queryClient,
  repositoriesQuery,
  signal,
  stream = streamRepositoryChanges,
  documentRef = typeof document === "undefined" ? undefined : document,
  retryDelayMs = 1_000,
  warningGraceMs = LIVE_UPDATES_WARNING_GRACE_MS,
  staleAfterMs = REPOSITORY_SSE_STALE_AFTER_MS,
  onLiveUpdatesUnavailable,
  onDiagnostic,
}: {
  queryClient: QueryClient
  repositoriesQuery: RepositoryMembershipLiveQuery
  signal: AbortSignal
  stream?: RepositoryMembershipLiveStream
  documentRef?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >
  retryDelayMs?: number
  warningGraceMs?: number
  staleAfterMs?: number
  onLiveUpdatesUnavailable?: (unavailable: boolean) => void
  onDiagnostic?: (diagnostic: RepositoryLiveDiagnostic) => void
}): Promise<void> => {
  let generation = 0
  let transportHealthy = false
  let lastActivityAt: number | null = null
  let warningTimer: ReturnType<typeof setTimeout> | undefined
  let unavailable = false

  let catchUpInFlight: Promise<void> | undefined
  let catchUpPending = false
  let catchUpGeneration = 0
  /** Generation of the pass currently executing inside the single-flight loop. */
  let catchUpRunningGeneration = 0
  let catchUpRetryDelayMs = retryDelayMs
  /** Resolvers for waits that should end early when `generation` advances. */
  const generationWaiters = new Set<() => void>()

  const wakeGenerationWaiters = () => {
    const waiters = [...generationWaiters]
    generationWaiters.clear()
    for (const wake of waiters) wake()
  }

  const emit = (diagnostic: RepositoryLiveDiagnostic) => {
    try {
      onDiagnostic?.(diagnostic)
    } catch {
      // Diagnostics must never gate transport health or catch-up.
    }
  }

  const setUnavailable = (next: boolean) => {
    if (unavailable === next) return
    unavailable = next
    onLiveUpdatesUnavailable?.(next)
  }

  const clearWarningTimer = () => {
    if (warningTimer !== undefined) {
      clearTimeout(warningTimer)
      warningTimer = undefined
    }
  }

  const markTransportHealthy = (forGeneration: number) => {
    if (forGeneration !== generation || signal.aborted) return
    transportHealthy = true
    lastActivityAt = Date.now()
    clearWarningTimer()
    setUnavailable(false)
  }

  const markTransportUnhealthy = () => {
    transportHealthy = false
    // Start grace timer only once per degraded stretch.
    warningTimer ??= setTimeout(() => {
      if (!signal.aborted && !transportHealthy) {
        setUnavailable(true)
      }
    }, warningGraceMs)
  }

  /**
   * Wait up to `ms`, ending early on outer abort or when `generation` leaves
   * `whileGeneration` (so reconnect catch-up is not blocked by old backoff).
   *
   * Uses subscribe-then-recheck so a wake between the initial check and
   * listener registration cannot leave the wait stuck for the full timer.
   */
  const waitForMs = (
    ms: number,
    { whileGeneration }: { whileGeneration?: number } = {},
  ) =>
    new Promise<void>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => finish()
      const onGeneration = () => finish()
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        if (whileGeneration !== undefined) {
          generationWaiters.delete(onGeneration)
        }
        resolve()
      }
      const shouldEndEarly = () =>
        signal.aborted ||
        (whileGeneration !== undefined && generation !== whileGeneration)

      if (shouldEndEarly()) {
        resolve()
        return
      }
      timer = setTimeout(finish, ms)
      signal.addEventListener("abort", onAbort, { once: true })
      if (whileGeneration !== undefined) {
        generationWaiters.add(onGeneration)
      }
      // Recheck after subscribe: abort/generation may have advanced in the gap.
      if (shouldEndEarly()) finish()
    })

  const catchUpMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message
    return String(error)
  }

  /**
   * Single-flight authoritative Repository refresh. Fire-and-forget dedicated
   * open-PR counts so Keymaxxer counting cannot delay or couple to membership
   * catch-up. Failures retry independently without changing transport health.
   *
   * Same-generation reschedules are trailing-edge only (set pending, do not
   * cancel). A newer reconnect generation cancels the in-flight membership
   * fetch so catch-up cannot overlap across generations.
   */
  const scheduleCatchUp = (forGeneration: number) => {
    if (signal.aborted) return
    if (forGeneration !== generation) return
    catchUpPending = true
    catchUpGeneration = forGeneration
    if (catchUpInFlight !== undefined) {
      // Only cancel when a newer generation supersedes an older in-flight pass.
      // Same-generation onChange/visibility just coalesces a trailing pass.
      if (forGeneration > catchUpRunningGeneration) {
        void queryClient.cancelQueries({
          queryKey: repositoriesQuery.queryKey,
          exact: true,
        })
      }
      return
    }

    catchUpInFlight = (async () => {
      try {
        while (catchUpPending && !signal.aborted) {
          catchUpPending = false
          const activeGeneration = catchUpGeneration
          catchUpRunningGeneration = activeGeneration
          if (activeGeneration !== generation) {
            // Superseded before this pass started; trailing pending (if any)
            // was already set by the newer scheduleCatchUp call.
            continue
          }

          // Dedicated count projection: schedule only.
          void queryClient
            .invalidateQueries({ queryKey: openPullRequestCountsQueryKey })
            .catch(() => undefined)

          try {
            await queryClient.fetchQuery({
              ...repositoriesQuery,
              staleTime: 0,
            })
            // Successful catch-up resets failure backoff.
            catchUpRetryDelayMs = retryDelayMs
          } catch (error) {
            if (signal.aborted) return
            // TanStack cancel (generation supersede or external) is not a failure.
            if (isCancelledError(error) || activeGeneration !== generation) {
              if (!signal.aborted && catchUpGeneration === generation) {
                catchUpPending = true
              }
              continue
            }
            emit({
              event: "catch_up_failure",
              generation: activeGeneration,
              message: catchUpMessage(error),
            })
            await waitForMs(catchUpRetryDelayMs, {
              whileGeneration: activeGeneration,
            })
            // Only grow backoff if this generation is still current.
            if (activeGeneration === generation && !signal.aborted) {
              catchUpRetryDelayMs = Math.min(
                catchUpRetryDelayMs * 2,
                CATCH_UP_RETRY_MAX_DELAY_MS,
              )
              catchUpPending = true
            } else if (!signal.aborted && catchUpGeneration === generation) {
              catchUpPending = true
            }
          }
        }
      } finally {
        catchUpInFlight = undefined
        catchUpRunningGeneration = 0
        if (catchUpPending && !signal.aborted) {
          scheduleCatchUp(generation)
        }
      }
    })()
  }

  const refreshWhenVisible = () => {
    if (documentRef?.visibilityState === "visible") {
      // Visibility catch-up must not flip transport health.
      scheduleCatchUp(generation)
    }
  }

  documentRef?.addEventListener("visibilitychange", refreshWhenVisible)

  // Connecting: arm the grace warning until transport is healthy.
  markTransportUnhealthy()

  try {
    while (!signal.aborted) {
      generation += 1
      const attemptGeneration = generation
      // New stream generation: reset catch-up backoff, activity age, and wake
      // any wait bound to the previous generation so reconnect catch-up is not
      // delayed and disconnect diagnostics do not inherit prior activity.
      catchUpRetryDelayMs = retryDelayMs
      lastActivityAt = null
      let attemptMarkedHealthy = false
      wakeGenerationWaiters()

      if (attemptGeneration > 1) {
        emit({
          event: "reconnect",
          generation: attemptGeneration,
          reason: "retry",
        })
        // Drop superseded membership fetches so reconnect catch-up is single-flight.
        void queryClient.cancelQueries({
          queryKey: repositoriesQuery.queryKey,
          exact: true,
        })
      }

      const attempt = new AbortController()
      const onAbort = () => attempt.abort()
      signal.addEventListener("abort", onAbort, { once: true })

      let disconnectReason: RepositoryLiveStreamDisconnectReason =
        "stream_ended"
      let heartbeatAgeMs: number | null = null

      try {
        const end = await stream({
          signal: attempt.signal,
          staleAfterMs,
          onConnected: () => {
            if (attemptGeneration !== generation) return
            // Transport + catch-up first so a throwing diagnostic cannot leave
            // a live stream marked unavailable without catch-up.
            markTransportHealthy(attemptGeneration)
            attemptMarkedHealthy = true
            scheduleCatchUp(attemptGeneration)
            emit({ event: "connect", generation: attemptGeneration })
          },
          onChange: () => {
            if (attemptGeneration !== generation) return
            lastActivityAt = Date.now()
            scheduleCatchUp(attemptGeneration)
          },
          onActivity: () => {
            if (attemptGeneration !== generation) return
            lastActivityAt = Date.now()
          },
        })
        if (attempt.signal.aborted || signal.aborted) {
          disconnectReason = "aborted"
        } else if (end === "complete") {
          disconnectReason = "complete"
        } else {
          // void/undefined from test doubles and quiet body close → stream_ended
          disconnectReason = "stream_ended"
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof RepositorySubscriptionStaleError) {
          disconnectReason = "stale"
          heartbeatAgeMs = error.heartbeatAgeMs
          emit({
            event: "stale",
            generation: attemptGeneration,
            heartbeatAgeMs: error.heartbeatAgeMs,
          })
        } else if (isAbortError(error)) {
          disconnectReason = "aborted"
        } else {
          disconnectReason = "error"
        }
      } finally {
        signal.removeEventListener("abort", onAbort)
        attempt.abort()
      }

      if (signal.aborted) return

      // Only report heartbeat age for attempts that established transport.
      if (
        heartbeatAgeMs === null &&
        attemptMarkedHealthy &&
        lastActivityAt !== null
      ) {
        heartbeatAgeMs = Date.now() - lastActivityAt
      }

      emit({
        event: "disconnect",
        generation: attemptGeneration,
        reason: disconnectReason,
        heartbeatAgeMs,
      })

      // Stream ended for this attempt; arm the grace warning until reconnect.
      markTransportUnhealthy()

      await waitForMs(retryDelayMs, { whileGeneration: attemptGeneration })
    }
  } finally {
    clearWarningTimer()
    generationWaiters.clear()
    documentRef?.removeEventListener("visibilitychange", refreshWhenVisible)
  }
}
