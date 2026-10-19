/**
 * Pure Provider Recovery schedule. Clock and jitter are inputs so tests can
 * fix both without sleeping.
 */

export const PROVIDER_RECOVERY_CLASSIFICATION = "retryable_provider_error"

/** Delays after consecutive transient failures: 1, 2, 4, 8, then 15 minutes. */
export const PROVIDER_RECOVERY_BASE_DELAYS_MS = [
  60_000, 120_000, 240_000, 480_000, 900_000,
] as const

/** Unresolved outage age after which recovery slows and escalates. */
export const PROVIDER_RECOVERY_ESCALATION_AFTER_MS = 3_600_000

export const PROVIDER_RECOVERY_ESCALATED_DELAY_MS = 1_800_000

/** Jitter never exceeds 15 seconds or 10% of the chosen delay. */
const PROVIDER_RECOVERY_JITTER_CAP_MS = 15_000

const providerRecoveryBaseDelayMs = (attempt: number): number => {
  const index =
    Math.min(Math.max(attempt, 1), PROVIDER_RECOVERY_BASE_DELAYS_MS.length) - 1
  const delay = PROVIDER_RECOVERY_BASE_DELAYS_MS[index]
  if (delay === undefined) {
    return 60_000
  }
  return delay
}

/**
 * Stable jitter in `[0, bound]`. The same seed and delay always agree, so a
 * restart that re-reads the persisted deadline does not need to recompute it,
 * and tests can predict a freshly scheduled deadline.
 */
export const providerRecoveryJitterMs = (
  seed: string,
  delayMs: number,
): number => {
  const bound = Math.min(
    PROVIDER_RECOVERY_JITTER_CAP_MS,
    Math.floor(delayMs / 10),
  )
  if (bound <= 0) {
    return 0
  }
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % (bound + 1)
}

export const providerRecoveryJitterSeed = (input: {
  readonly workItemId: string
  readonly episodeStartedAt: number
  readonly attempt: number
}): string => `${input.workItemId}:${input.episodeStartedAt}:${input.attempt}`

export type ProviderRecoverySchedule =
  | {
      readonly _tag: "schedule"
      readonly nextAttemptAt: number
      readonly escalated: boolean
      readonly delayMs: number
    }
  | { readonly _tag: "exhaust" }

/**
 * Next attempt for one classified failure. `attempt` is the 1-based count of
 * consecutive transient failures in the episode, including this one.
 * A null maximum means unlimited waiting. A future provider deadline is a
 * floor, never a reason to retry early. A deadline or backoff that would
 * start at or after the maximum elapsed wait exhausts instead.
 */
export const scheduleProviderRecovery = (input: {
  readonly now: number
  readonly attempt: number
  readonly episodeStartedAt: number
  readonly providerRetryAt: number | null
  readonly maxWaitMs: number | null
  readonly jitterSeed: string
}): ProviderRecoverySchedule => {
  const elapsed = Math.max(0, input.now - input.episodeStartedAt)
  if (input.maxWaitMs !== null && elapsed >= input.maxWaitMs) {
    return { _tag: "exhaust" }
  }
  const escalated = elapsed >= PROVIDER_RECOVERY_ESCALATION_AFTER_MS
  const delayMs = escalated
    ? PROVIDER_RECOVERY_ESCALATED_DELAY_MS
    : providerRecoveryBaseDelayMs(input.attempt)
  const jitterMs = providerRecoveryJitterMs(input.jitterSeed, delayMs)
  let nextAttemptAt = input.now + delayMs + jitterMs
  if (
    input.providerRetryAt !== null &&
    Number.isFinite(input.providerRetryAt) &&
    input.providerRetryAt > nextAttemptAt
  ) {
    nextAttemptAt = input.providerRetryAt
  }
  if (
    input.maxWaitMs !== null &&
    nextAttemptAt - input.episodeStartedAt >= input.maxWaitMs
  ) {
    return { _tag: "exhaust" }
  }
  return { _tag: "schedule", nextAttemptAt, escalated, delayMs }
}

export const providerRecoveryElapsedExceedsMax = (input: {
  readonly now: number
  readonly episodeStartedAt: number
  readonly maxWaitMs: number | null
}): boolean =>
  input.maxWaitMs !== null &&
  input.now - input.episodeStartedAt >= input.maxWaitMs
