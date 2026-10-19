/**
 * Pure Provider Recovery Cooldown scope. Credentials never become key parts.
 * Clock and population are inputs so tests can fix both without sleeping.
 */

export type ProviderRecoveryScopeKind = "model" | "provider"

const SCOPE_SEPARATOR = "\u0000"

/**
 * Explicit provider-wide quota and rate-limit codes. Model capacity
 * (`server_overloaded` and other unclassified transient codes) stays
 * model-scoped so an overloaded model does not block unrelated models.
 */
export const providerRecoveryScopeKind = (
  providerCode: string | null | undefined,
): ProviderRecoveryScopeKind => {
  if (providerCode === null || providerCode === undefined) {
    return "model"
  }
  const normalized = providerCode
    .trim()
    .toLowerCase()
    .replace(/[.\-\s]/g, "_")
  if (
    normalized.includes("rate_limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("quota")
  ) {
    return "provider"
  }
  return "model"
}

const SAFE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/

const CREDENTIAL_ACCOUNT =
  /(?:^|[_-])(?:sk|key|token|secret|password|bearer|api|pat)(?:[_-]|$)|sk-|bearer\s|\[redacted\]|^eyJ/i

/**
 * Account identity safe to persist. Returns null for missing, secret-shaped,
 * or otherwise unsafe values so the scope omits the account rather than
 * storing a credential.
 */
export const safeProviderAccountIdentity = (
  value: string | null | undefined,
): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  const trimmed = value.trim()
  if (!SAFE_ACCOUNT.test(trimmed) || CREDENTIAL_ACCOUNT.test(trimmed)) {
    return null
  }
  return trimmed
}

export const providerRecoveryScopeKey = (input: {
  readonly backend: string
  readonly providerId: string | null
  readonly accountId: string | null
  readonly model: string | null
  readonly kind: ProviderRecoveryScopeKind
}): string => {
  const model = input.kind === "provider" ? "" : (input.model ?? "").trim()
  return [
    input.backend.trim(),
    (input.providerId ?? "").trim(),
    safeProviderAccountIdentity(input.accountId) ?? "",
    input.kind,
    model,
  ].join(SCOPE_SEPARATOR)
}

/**
 * Follower offset inside the existing jitter cap so waiting items do not
 * share the probe's timestamp. Rank is 1-based among followers.
 */
export const providerRecoveryFollowerOffsetMs = (input: {
  readonly rank: number
  readonly population: number
  readonly delayMs: number
}): number => {
  const bound = Math.min(15_000, Math.floor(Math.max(input.delayMs, 1) / 10))
  if (bound <= 0) {
    return 1
  }
  const spacing = Math.max(1, Math.floor(bound / Math.max(input.population, 1)))
  return Math.min(bound, Math.max(input.rank, 1) * spacing)
}

export type AlignedRecoveryAttempt =
  | { readonly _tag: "exhaust" }
  | {
      readonly _tag: "wait"
      readonly nextAttemptAt: number
      readonly role: "probe" | "follower"
    }

/**
 * Visible next attempt is never earlier than the shared deadline or the
 * item's own schedule (which already honors a provider retry deadline).
 * A shared deadline that would pass the item's elapsed-time limit exhausts
 * that item instead of showing a next attempt past the limit.
 */
export const alignRecoveryAttempt = (input: {
  readonly now: number
  readonly episodeStartedAt: number
  readonly maxWaitMs: number | null
  readonly individualNextAttemptAt: number
  readonly sharedDeadline: number
  readonly role: "probe" | "follower"
  readonly followerOffsetMs: number
}): AlignedRecoveryAttempt => {
  if (
    input.maxWaitMs !== null &&
    input.now - input.episodeStartedAt >= input.maxWaitMs
  ) {
    return { _tag: "exhaust" }
  }
  const base = Math.max(input.individualNextAttemptAt, input.sharedDeadline)
  const nextAttemptAt =
    input.role === "probe" ? base : base + Math.max(0, input.followerOffsetMs)
  if (
    input.maxWaitMs !== null &&
    nextAttemptAt - input.episodeStartedAt >= input.maxWaitMs
  ) {
    return { _tag: "exhaust" }
  }
  return { _tag: "wait", nextAttemptAt, role: input.role }
}

export const readAccountIdFromCause = (error: unknown): string | null => {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (typeof current === "object") {
      const record = current as Record<string, unknown>
      if (typeof record.accountId === "string") {
        return safeProviderAccountIdentity(record.accountId)
      }
      if ("cause" in record && record.cause !== undefined) {
        current = record.cause
        continue
      }
      if (Array.isArray(record.errors) && record.errors.length > 0) {
        current = record.errors[0]
        continue
      }
    }
    break
  }
  return null
}
