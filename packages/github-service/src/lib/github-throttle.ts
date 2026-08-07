import { GitHubThrottledError } from "./errors.js"

export const SECONDARY_THROTTLE_FALLBACK_MILLIS = 60_000
const PRIMARY_THROTTLE_FALLBACK_MILLIS = 60_000

const headerInteger = (headers: Headers, name: string): number | undefined => {
  const value = headers.get(name)
  if (value === null || !/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const retryAfterMillis = (headers: Headers): number | undefined => {
  const seconds = headerInteger(headers, "retry-after")
  return seconds === undefined ? undefined : seconds * 1_000
}

const resetAt = (headers: Headers): number | undefined => {
  const seconds = headerInteger(headers, "x-ratelimit-reset")
  return seconds === undefined ? undefined : seconds * 1_000
}

const isSecondaryLimitMessage = (message: string): boolean => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("secondary rate limit") ||
    normalized.includes("secondary rate-limits") ||
    normalized.includes("please wait a few minutes before you try again")
  )
}

const isPrimaryLimitMessage = (message: string): boolean => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("api rate limit exceeded") ||
    (normalized.includes("rate limit exceeded") &&
      !isSecondaryLimitMessage(normalized))
  )
}

const withRetryAfter = (input: {
  readonly headers: Headers
  readonly now: number
}): GitHubThrottledError | undefined => {
  const delay = retryAfterMillis(input.headers)
  return delay === undefined
    ? undefined
    : new GitHubThrottledError({
        retryAt: input.now + delay,
        usedFallback: false,
      })
}

/**
 * Normalizes only explicit GitHub throttle evidence. A plain 403 remains a
 * request error, which preserves the Checks-to-Actions fine-grained PAT
 * fallback path.
 */
export const githubThrottleFromResponse = (input: {
  readonly statusCode: number
  readonly headers: Headers
  readonly message: string
  readonly now?: number
}): GitHubThrottledError | undefined => {
  const now = input.now ?? Date.now()
  const remaining = headerInteger(input.headers, "x-ratelimit-remaining")
  const reset = resetAt(input.headers)
  const retryAfter = withRetryAfter({ headers: input.headers, now })

  if (remaining === 0 && reset !== undefined && reset > now) {
    return new GitHubThrottledError({ retryAt: reset, usedFallback: false })
  }
  if (retryAfter !== undefined) return retryAfter

  const secondary = isSecondaryLimitMessage(input.message)
  if (secondary || input.statusCode === 429) {
    return new GitHubThrottledError({
      retryAt: now + SECONDARY_THROTTLE_FALLBACK_MILLIS,
      usedFallback: true,
    })
  }
  if (isPrimaryLimitMessage(input.message)) {
    return new GitHubThrottledError({
      retryAt:
        reset !== undefined && reset > now
          ? reset
          : now + PRIMARY_THROTTLE_FALLBACK_MILLIS,
      // Only deadline-less secondary limits use exponential coordinator backoff.
      usedFallback: false,
    })
  }
  return undefined
}

/** A successful final-quota response closes admission for later operations. */
export const githubThrottleFromSuccessfulResponse = (input: {
  readonly headers: Headers
  readonly now?: number
}): GitHubThrottledError | undefined => {
  const now = input.now ?? Date.now()
  const remaining = headerInteger(input.headers, "x-ratelimit-remaining")
  const reset = resetAt(input.headers)
  if (remaining !== 0 || reset === undefined || reset <= now) return undefined
  return new GitHubThrottledError({ retryAt: reset, usedFallback: false })
}
