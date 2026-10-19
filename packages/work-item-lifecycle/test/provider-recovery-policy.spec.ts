import {
  PROVIDER_RECOVERY_BASE_DELAYS_MS,
  PROVIDER_RECOVERY_ESCALATED_DELAY_MS,
  PROVIDER_RECOVERY_ESCALATION_AFTER_MS,
  providerRecoveryJitterMs,
  providerRecoveryJitterSeed,
  scheduleProviderRecovery,
} from "../src/lib/provider-recovery-policy.js"
import { describe, expect, it } from "bun:test"

const seed = providerRecoveryJitterSeed({
  workItemId: "wi-test",
  episodeStartedAt: 1_000,
  attempt: 1,
})

describe("Provider Recovery schedule", () => {
  it("uses 1, 2, 4, 8, then 15 minute delays plus bounded jitter", () => {
    for (const [index, delayMs] of PROVIDER_RECOVERY_BASE_DELAYS_MS.entries()) {
      const now = 10_000
      const scheduled = scheduleProviderRecovery({
        now,
        attempt: index + 1,
        episodeStartedAt: 1_000,
        providerRetryAt: null,
        maxWaitMs: null,
        jitterSeed: seed,
      })
      expect(scheduled._tag).toBe("schedule")
      if (scheduled._tag !== "schedule") {
        return
      }
      const jitter = providerRecoveryJitterMs(seed, delayMs)
      expect(jitter).toBeGreaterThanOrEqual(0)
      expect(jitter).toBeLessThanOrEqual(
        Math.min(15_000, Math.floor(delayMs / 10)),
      )
      expect(scheduled.nextAttemptAt).toBe(now + delayMs + jitter)
      expect(scheduled.escalated).toBe(false)
    }
  })

  it("never schedules before a future provider deadline", () => {
    const now = 10_000
    const providerRetryAt = now + 3_600_000
    const scheduled = scheduleProviderRecovery({
      now,
      attempt: 1,
      episodeStartedAt: now,
      providerRetryAt,
      maxWaitMs: null,
      jitterSeed: seed,
    })
    expect(scheduled).toMatchObject({
      _tag: "schedule",
      nextAttemptAt: providerRetryAt,
    })
  })

  it("ignores a provider deadline that is already past", () => {
    const now = 120_000
    const scheduled = scheduleProviderRecovery({
      now,
      attempt: 1,
      episodeStartedAt: 0,
      providerRetryAt: 1_000,
      maxWaitMs: null,
      jitterSeed: seed,
    })
    expect(scheduled._tag).toBe("schedule")
    if (scheduled._tag !== "schedule") {
      return
    }
    expect(scheduled.nextAttemptAt).toBeGreaterThan(now)
    expect(scheduled.nextAttemptAt).toBeLessThan(providerRetryAtFloor(now))
  })

  it("switches to a 30 minute cadence and escalates after one hour", () => {
    const episodeStartedAt = 0
    const now = PROVIDER_RECOVERY_ESCALATION_AFTER_MS
    const scheduled = scheduleProviderRecovery({
      now,
      attempt: 6,
      episodeStartedAt,
      providerRetryAt: null,
      maxWaitMs: null,
      jitterSeed: seed,
    })
    expect(scheduled._tag).toBe("schedule")
    if (scheduled._tag !== "schedule") {
      return
    }
    expect(scheduled.escalated).toBe(true)
    expect(scheduled.delayMs).toBe(PROVIDER_RECOVERY_ESCALATED_DELAY_MS)
    expect(scheduled.nextAttemptAt).toBe(
      now +
        PROVIDER_RECOVERY_ESCALATED_DELAY_MS +
        providerRecoveryJitterMs(seed, PROVIDER_RECOVERY_ESCALATED_DELAY_MS),
    )
  })

  it("exhausts when elapsed waiting already meets a configured maximum", () => {
    expect(
      scheduleProviderRecovery({
        now: 90_000,
        attempt: 2,
        episodeStartedAt: 0,
        providerRetryAt: null,
        maxWaitMs: 90_000,
        jitterSeed: seed,
      }),
    ).toEqual({ _tag: "exhaust" })
  })

  it("exhausts instead of scheduling past the maximum, including a later provider deadline", () => {
    expect(
      scheduleProviderRecovery({
        now: 50_000,
        attempt: 1,
        episodeStartedAt: 0,
        providerRetryAt: 120_000,
        maxWaitMs: 90_000,
        jitterSeed: seed,
      }),
    ).toEqual({ _tag: "exhaust" })
  })

  it("keeps waiting unlimited when the maximum is null", () => {
    const scheduled = scheduleProviderRecovery({
      now: PROVIDER_RECOVERY_ESCALATION_AFTER_MS * 5,
      attempt: 9,
      episodeStartedAt: 0,
      providerRetryAt: null,
      maxWaitMs: null,
      jitterSeed: seed,
    })
    expect(scheduled._tag).toBe("schedule")
  })
})

const providerRetryAtFloor = (now: number): number =>
  now + PROVIDER_RECOVERY_BASE_DELAYS_MS[0]! + 15_000
