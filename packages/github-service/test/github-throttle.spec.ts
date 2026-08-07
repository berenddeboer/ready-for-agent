import { describe, expect, it } from "vitest"
import {
  githubThrottleFromResponse,
  githubThrottleFromSuccessfulResponse,
} from "../src/lib/github-throttle.js"

describe("GitHub throttle normalization", () => {
  it("uses injected time for explicit and fallback deadlines", () => {
    const now = 10_000

    expect(
      githubThrottleFromResponse({
        statusCode: 403,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "120",
        }),
        message: "API rate limit exceeded",
        now,
      }),
    ).toMatchObject({ retryAt: 120_000, usedFallback: false })
    expect(
      githubThrottleFromResponse({
        statusCode: 429,
        headers: new Headers(),
        message: "Too many requests",
        now,
      }),
    ).toMatchObject({ retryAt: 70_000, usedFallback: true })
    expect(
      githubThrottleFromSuccessfulResponse({
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "120",
        }),
        now,
      }),
    ).toMatchObject({ retryAt: 120_000, usedFallback: false })
  })
})
