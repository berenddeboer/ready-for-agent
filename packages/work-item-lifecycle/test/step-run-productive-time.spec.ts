import {
  computeProductiveElapsedMs,
  computeReviewProgressElapsedMs,
  computeStepTimeoutElapsedMs,
} from "../src/lib/step-run-productive-time.js"
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

describe("computeReviewProgressElapsedMs", () => {
  it("falls back to start when no checkpoint exists", () => {
    expect(
      computeReviewProgressElapsedMs(
        {
          started_at: 1_000,
          session_wait_ms: 200,
          session_wait_started_at: null,
          progress_checkpoint_at: null,
          progress_checkpoint_session_wait_ms: null,
        },
        1_800,
      ),
    ).toBe(600)
  })

  it("measures from the checkpoint and ignores earlier waiting", () => {
    expect(
      computeReviewProgressElapsedMs(
        {
          started_at: 1_000,
          session_wait_ms: 700,
          session_wait_started_at: null,
          progress_checkpoint_at: 2_000,
          progress_checkpoint_session_wait_ms: 700,
        },
        2_400,
      ),
    ).toBe(400)
  })

  it("subtracts only waiting accrued after the checkpoint", () => {
    expect(
      computeReviewProgressElapsedMs(
        {
          started_at: 1_000,
          session_wait_ms: 900,
          session_wait_started_at: null,
          progress_checkpoint_at: 2_000,
          progress_checkpoint_session_wait_ms: 700,
        },
        2_500,
      ),
    ).toBe(300)
  })

  it("does not count an open wait that began before the checkpoint twice", () => {
    expect(
      computeReviewProgressElapsedMs(
        {
          started_at: 1_000,
          session_wait_ms: 400,
          session_wait_started_at: 1_800,
          progress_checkpoint_at: 2_000,
          progress_checkpoint_session_wait_ms: 600,
        },
        2_500,
      ),
    ).toBe(0)
  })
})

describe("computeStepTimeoutElapsedMs", () => {
  it("uses checkpoint time only for Review", () => {
    const row = {
      started_at: 1_000,
      session_wait_ms: 0,
      session_wait_started_at: null,
      progress_checkpoint_at: 2_000,
      progress_checkpoint_session_wait_ms: 0,
    }
    expect(computeStepTimeoutElapsedMs("review", row, 2_300)).toBe(300)
    expect(computeStepTimeoutElapsedMs("implement", row, 2_300)).toBe(1_300)
  })
})
