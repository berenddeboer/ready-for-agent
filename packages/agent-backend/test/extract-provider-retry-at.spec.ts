import { extractProviderRetryAt } from "../src/lib/extract-provider-retry-at.js"
import { describe, expect, it } from "bun:test"

const NOW = Date.parse("2026-08-15T12:00:00.000Z")

describe("extractProviderRetryAt", () => {
  it("reads a numeric retryAfter delay in seconds", () => {
    expect(
      extractProviderRetryAt({
        data: { retryAfter: 90 },
        now: NOW,
      }),
    ).toBe(NOW + 90_000)
  })

  it("reads retry-after header seconds", () => {
    expect(
      extractProviderRetryAt({
        data: { headers: { "retry-after": "45" } },
        now: NOW,
      }),
    ).toBe(NOW + 45_000)
  })

  it("reads x-ratelimit-reset unix seconds", () => {
    const reset = Math.floor(NOW / 1000) + 120
    expect(
      extractProviderRetryAt({
        data: { headers: { "x-ratelimit-reset": String(reset) } },
        now: NOW,
      }),
    ).toBe(reset * 1000)
  })

  it("reads an ISO retryAt timestamp", () => {
    expect(
      extractProviderRetryAt({
        data: { retryAt: "2026-08-15T12:05:00.000Z" },
        now: NOW,
      }),
    ).toBe(Date.parse("2026-08-15T12:05:00.000Z"))
  })

  it("reads a unix-ms retryAt field", () => {
    const retryAt = NOW + 30_000
    expect(extractProviderRetryAt({ data: { retryAt }, now: NOW })).toBe(
      retryAt,
    )
  })

  it("looks inside nested data objects used by provider APIError payloads", () => {
    expect(
      extractProviderRetryAt({
        data: { data: { retryAfter: 12 } },
        now: NOW,
      }),
    ).toBe(NOW + 12_000)
  })

  it("rejects prose, non-numeric strings, and negative values", () => {
    expect(
      extractProviderRetryAt({
        data: { message: "retry after a few minutes" },
        now: NOW,
      }),
    ).toBeUndefined()
    expect(
      extractProviderRetryAt({
        data: { retryAfter: "soon" },
        now: NOW,
      }),
    ).toBeUndefined()
    expect(
      extractProviderRetryAt({
        data: { retryAfter: -5 },
        now: NOW,
      }),
    ).toBeUndefined()
    expect(extractProviderRetryAt({ data: null, now: NOW })).toBeUndefined()
    expect(extractProviderRetryAt({ now: NOW })).toBeUndefined()
  })
})
