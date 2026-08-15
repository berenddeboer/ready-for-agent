const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const readHeader = (headers: unknown, name: string): string | undefined => {
  const record = asRecord(headers)
  if (record === null) {
    return undefined
  }
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== wanted) {
      continue
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value)
    }
  }
  return undefined
}

const parseDelaySeconds = (value: number, now: number): number | undefined => {
  if (!Number.isFinite(value) || value < 0) {
    return undefined
  }
  // Treat large values as absolute unix seconds, not a delay.
  if (value >= 1_000_000_000) {
    return Math.trunc(value * 1000)
  }
  return now + Math.trunc(value * 1000)
}

const parseEpochLike = (value: number): number | undefined => {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined
  }
  if (value >= 1e12) {
    return Math.trunc(value)
  }
  if (value >= 1_000_000_000) {
    return Math.trunc(value * 1000)
  }
  return undefined
}

const parseNumericCandidate = (
  value: number,
  now: number,
): number | undefined => {
  const absolute = parseEpochLike(value)
  if (absolute !== undefined) {
    return absolute
  }
  return parseDelaySeconds(value, now)
}

const parseStringCandidate = (
  value: string,
  now: number,
): number | undefined => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return parseNumericCandidate(Number(trimmed), now)
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

const readNamedTime = (
  record: Record<string, unknown>,
  names: readonly string[],
  now: number,
): number | undefined => {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) {
      continue
    }
    const value = record[name]
    if (typeof value === "number") {
      const parsed = parseNumericCandidate(value, now)
      if (parsed !== undefined) {
        return parsed
      }
    }
    if (typeof value === "string") {
      const parsed = parseStringCandidate(value, now)
      if (parsed !== undefined) {
        return parsed
      }
    }
  }
  return undefined
}

const extractFromRecord = (
  record: Record<string, unknown>,
  now: number,
): number | undefined => {
  const named = readNamedTime(
    record,
    ["retryAt", "retry_at", "resetAt", "reset_at", "reset"],
    now,
  )
  if (named !== undefined) {
    return named
  }

  const delay = readNamedTime(record, ["retryAfter", "retry_after"], now)
  if (delay !== undefined) {
    return delay
  }

  const retryAfterHeader = readHeader(record.headers, "retry-after")
  if (retryAfterHeader !== undefined) {
    const parsed = parseStringCandidate(retryAfterHeader, now)
    if (parsed !== undefined) {
      return parsed
    }
  }

  const resetHeader = readHeader(record.headers, "x-ratelimit-reset")
  if (resetHeader !== undefined) {
    const parsed = parseStringCandidate(resetHeader, now)
    if (parsed !== undefined) {
      return parsed
    }
  }

  const nested = asRecord(record.data)
  if (nested !== null) {
    return extractFromRecord(nested, now)
  }
  return undefined
}

/**
 * Trustworthy machine-readable retry time from a provider error payload.
 * Accepts numeric delays, epoch timestamps, ISO-8601, HTTP-date, Retry-After,
 * and x-ratelimit-reset. Does not parse operator-facing prose.
 */
export const extractProviderRetryAt = (input: {
  readonly data?: unknown
  readonly now: number
}): number | undefined => {
  const record = asRecord(input.data)
  if (record === null) {
    return undefined
  }
  return extractFromRecord(record, input.now)
}
