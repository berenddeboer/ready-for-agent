import { renderToStaticMarkup } from "react-dom/server"
import { ProviderRecoverySettingsFields } from "../src/provider-recovery-settings.js"
import {
  ProviderRecoveryStatus,
  type ProviderRecoveryView,
} from "../src/provider-recovery-status.js"
import { describe, expect, test } from "bun:test"

const now = Date.parse("2026-10-19T12:00:00.000Z")

const recovery = (
  overrides: Partial<ProviderRecoveryView> = {},
): ProviderRecoveryView => ({
  status: "SCHEDULED",
  lifecycleStep: "investigate_pr_status_checks",
  providerId: "openai",
  providerLabel: "OpenAI",
  model: "gpt-5.5",
  providerCode: "server_overloaded",
  reasonMessage: "Selected model is at capacity. Please try a different model.",
  episodeStartedAt: new Date(now - 12 * 60_000).toISOString(),
  attemptCount: 3,
  nextAttemptAt: new Date(now + 4 * 60_000).toISOString(),
  escalated: false,
  exhaustedAt: null,
  ...overrides,
})

describe("ProviderRecoveryStatus", () => {
  test("counts down from the persisted next attempt and advances with the clock", () => {
    const waiting = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery()}
        nowMs={now}
        paused={false}
      />,
    )
    const later = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery()}
        nowMs={now + 60_000}
        paused={false}
      />,
    )

    expect(waiting).toContain('data-provider-recovery="waiting"')
    expect(waiting).toContain("Model at capacity — retrying in 4 minutes")
    expect(waiting).toContain("OpenAI · gpt-5.5")
    expect(waiting).toContain("3 failed attempts")
    expect(waiting).toContain("Waiting 12 minutes")
    expect(waiting).toContain(
      "Last cause: Selected model is at capacity. Please try a different model.",
    )
    expect(waiting).toContain("Next attempt 2026-10-19T12:04:00.000Z")
    expect(waiting).not.toContain("Automatic recovery stopped")
    expect(later).toContain("Model at capacity — retrying in 3 minutes")
    expect(later).toContain("Waiting 13 minutes")
  })

  test("retrying is distinct from waiting and from a manual failure", () => {
    const html = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery({ status: "IN_ATTEMPT", nextAttemptAt: null })}
        nowMs={now}
        paused={false}
      />,
    )
    expect(html).toContain('data-provider-recovery="retrying"')
    expect(html).toContain("Retrying the same model")
    expect(html).not.toContain("retrying in")
    expect(html).not.toContain("Retry to continue")
  })

  test("recovered clears the outage warning", () => {
    const html = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery({
          status: "RECOVERED",
          escalated: true,
          nextAttemptAt: null,
        })}
        nowMs={now}
        paused={false}
      />,
    )
    expect(html).toContain('data-provider-recovery="recovered"')
    expect(html).toContain("Provider recovered")
    expect(html).not.toContain("Automatic recovery continues")
    expect(html).not.toContain("retrying in")
  })

  test("a prolonged outage warns once and says recovery continues", () => {
    const html = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery({ escalated: true })}
        nowMs={now}
        paused={false}
      />,
    )
    expect(html).toContain('data-provider-recovery-escalation="true"')
    expect(html).toContain("Provider outage for over an hour")
    expect(html).toContain("Automatic recovery continues")
    expect(html.match(/Provider outage for over an hour/g)).toHaveLength(1)
  })

  test("pause cancels the countdown", () => {
    const html = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery({ status: "CANCELLED", nextAttemptAt: null })}
        nowMs={now}
        paused
      />,
    )
    expect(html).toContain('data-provider-recovery="paused"')
    expect(html).toContain("will not resume until Retry")
    expect(html).not.toContain("retrying in")
  })

  test("maximum-wait exhaustion is actionable and keeps the session offer", () => {
    const html = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery({
          status: "EXHAUSTED",
          nextAttemptAt: null,
          exhaustedAt: new Date(now).toISOString(),
        })}
        nowMs={now}
        paused={false}
      />,
    )
    expect(html).toContain('data-provider-recovery="exhausted"')
    expect(html).toContain("session and work are kept")
    expect(html).toContain("Retry to continue")
    expect(html).not.toContain("retrying in")
  })

  test("an exited permanent failure does not invent a countdown", () => {
    const html = renderToStaticMarkup(
      <ProviderRecoveryStatus
        recovery={recovery({
          status: "EXITED",
          reasonMessage: "Billing is not active for this account.",
          nextAttemptAt: null,
        })}
        nowMs={now}
        paused={false}
      />,
    )
    expect(html).toBe("")
  })
})

describe("ProviderRecoverySettingsFields", () => {
  test("explains Keep retrying and the backoff", () => {
    const html = renderToStaticMarkup(
      <ProviderRecoverySettingsFields
        mode="unlimited"
        minutes=""
        onModeChange={() => undefined}
        onMinutesChange={() => undefined}
      />,
    )
    expect(html).toContain("Keep retrying")
    expect(html).toContain("1, 2, 4, 8, then 15 minutes")
    expect(html).toContain("30 minutes")
    expect(html).toContain("original outage start")
  })
})
