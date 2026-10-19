import {
  PROVIDER_RECOVERY_ESCALATION_MESSAGE,
  PROVIDER_RECOVERY_EXHAUSTED_MESSAGE,
  type ProviderRecoverySnapshot,
  formatProviderRecoveryApiMessage,
  formatProviderRecoveryElapsed,
  formatProviderRecoveryMaxWaitMinutes,
  formatProviderRecoveryWaitingHeadline,
  parseProviderRecoveryMaxWaitMinutes,
} from "../src/lib/provider-recovery-presentation.js"
import { describe, expect, test } from "bun:test"

const now = Date.parse("2026-10-19T12:00:00.000Z")

const episode = (
  overrides: Partial<ProviderRecoverySnapshot> = {},
): ProviderRecoverySnapshot => ({
  status: "scheduled",
  lifecycleStep: "investigate_pr_status_checks",
  providerId: "openai",
  providerLabel: "OpenAI",
  model: "gpt-5.5",
  providerCode: "server_overloaded",
  reasonMessage: "Selected model is at capacity. Please try a different model.",
  episodeStartedAt: now - 12 * 60_000,
  attemptCount: 3,
  nextAttemptAt: now + 4 * 60_000,
  escalated: false,
  exhaustedAt: null,
  ...overrides,
})

describe("Provider Recovery presentation", () => {
  test("renders the capacity countdown from the persisted next attempt", () => {
    expect(
      formatProviderRecoveryWaitingHeadline({ episode: episode(), nowMs: now }),
    ).toBe("Model at capacity — retrying in 4 minutes")
    expect(
      formatProviderRecoveryWaitingHeadline({
        episode: episode(),
        nowMs: now + 60_000,
      }),
    ).toBe("Model at capacity — retrying in 3 minutes")
    expect(formatProviderRecoveryElapsed(12 * 60_000)).toBe("12 minutes")
  })

  test("keeps the API sentence on the authoritative instant, not a stale minute count", () => {
    expect(formatProviderRecoveryApiMessage(episode())).toBe(
      "Model at capacity — next attempt at 2026-10-19T12:04:00.000Z. OpenAI · gpt-5.5. 3 failed attempts.",
    )
  })

  test("exhausted and escalation copy stay distinct from a countdown", () => {
    expect(
      formatProviderRecoveryApiMessage(episode({ status: "exhausted" })),
    ).toBe(PROVIDER_RECOVERY_EXHAUSTED_MESSAGE)
    expect(PROVIDER_RECOVERY_ESCALATION_MESSAGE).toContain(
      "Automatic recovery continues",
    )
    expect(
      formatProviderRecoveryApiMessage(episode({ status: "exited" })),
    ).toBeNull()
  })

  test("Keep retrying is null and a finite duration is whole minutes", () => {
    expect(parseProviderRecoveryMaxWaitMinutes("unlimited", "")).toEqual({
      ok: true,
      maxWaitMs: null,
    })
    expect(parseProviderRecoveryMaxWaitMinutes("limited", "90")).toEqual({
      ok: true,
      maxWaitMs: 90 * 60_000,
    })
    expect(parseProviderRecoveryMaxWaitMinutes("limited", "0").ok).toBe(false)
    expect(parseProviderRecoveryMaxWaitMinutes("limited", "-5").ok).toBe(false)
    expect(parseProviderRecoveryMaxWaitMinutes("limited", "1.5").ok).toBe(false)
    expect(formatProviderRecoveryMaxWaitMinutes(null)).toEqual({
      mode: "unlimited",
      minutes: "",
    })
    expect(formatProviderRecoveryMaxWaitMinutes(90_000)).toEqual({
      mode: "limited",
      minutes: "2",
    })
  })
})
