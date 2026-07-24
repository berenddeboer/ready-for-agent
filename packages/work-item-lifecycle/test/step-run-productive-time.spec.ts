import { computeProductiveElapsedMs } from "../src/lib/step-run-productive-time.js"
import { describe, expect, it } from "bun:test"

describe("computeProductiveElapsedMs", () => {
  it("returns wall time when there is no session wait", () => {
    expect(
      computeProductiveElapsedMs(
        {
          started_at: 1_000,
          session_wait_ms: 0,
          session_wait_started_at: null,
        },
        1_500,
      ),
    ).toBe(500)
  })

  it("excludes completed session waits", () => {
    expect(
      computeProductiveElapsedMs(
        {
          started_at: 1_000,
          session_wait_ms: 400,
          session_wait_started_at: null,
        },
        1_800,
      ),
    ).toBe(400)
  })

  it("freezes during an open session wait", () => {
    expect(
      computeProductiveElapsedMs(
        {
          started_at: 1_000,
          session_wait_ms: 100,
          session_wait_started_at: 1_400,
        },
        2_000,
      ),
    ).toBe(300)
  })

  it("returns 0 before started_at", () => {
    expect(
      computeProductiveElapsedMs(
        {
          started_at: null,
          session_wait_ms: 0,
          session_wait_started_at: null,
        },
        1_000,
      ),
    ).toBe(0)
  })
})
