import {
  PROVIDER_RECOVERY_CONTROLS_MESSAGE,
  PROVIDER_RECOVERY_ESCALATION_MESSAGE,
  PROVIDER_RECOVERY_EXHAUSTED_MESSAGE,
  PROVIDER_RECOVERY_PAUSED_MESSAGE,
  PROVIDER_RECOVERY_RECOVERED_MESSAGE,
  PROVIDER_RECOVERY_RETRYING_MESSAGE,
  type ProviderRecoverySnapshot,
  formatProviderRecoveryElapsed,
  formatProviderRecoveryModel,
  formatProviderRecoveryWaitingHeadline,
  providerRecoveryIsOpen,
} from "@ready-for-agent/work-item-lifecycle/provider-recovery-presentation"
import { Banner } from "./banner.js"
import { ui } from "./ui.js"

export type ProviderRecoveryView = {
  readonly status:
    | "SCHEDULED"
    | "IN_ATTEMPT"
    | "RECOVERED"
    | "EXITED"
    | "EXHAUSTED"
    | "CANCELLED"
  readonly lifecycleStep: string
  readonly providerId: string | null
  readonly providerLabel: string | null
  readonly model: string | null
  readonly providerCode: string | null
  readonly reasonMessage: string | null
  readonly episodeStartedAt: string
  readonly attemptCount: number
  readonly nextAttemptAt: string | null
  readonly escalated: boolean
  readonly exhaustedAt: string | null
}

const snapshotFromView = (
  view: ProviderRecoveryView,
): ProviderRecoverySnapshot => ({
  status: view.status.toLowerCase() as ProviderRecoverySnapshot["status"],
  lifecycleStep: view.lifecycleStep,
  providerId: view.providerId,
  providerLabel: view.providerLabel,
  model: view.model,
  providerCode: view.providerCode,
  reasonMessage: view.reasonMessage,
  episodeStartedAt: Date.parse(view.episodeStartedAt),
  attemptCount: view.attemptCount,
  nextAttemptAt:
    view.nextAttemptAt === null ? null : Date.parse(view.nextAttemptAt),
  escalated: view.escalated,
  exhaustedAt: view.exhaustedAt === null ? null : Date.parse(view.exhaustedAt),
})

const attemptLabel = (count: number): string =>
  count === 1 ? "1 failed attempt" : `${count} failed attempts`

/**
 * Operator status for one persisted Provider Recovery Episode. `nowMs` is
 * injected so a reload renders the countdown from the stored next attempt
 * rather than a stale server sentence.
 */
export function ProviderRecoveryStatus({
  recovery,
  nowMs,
  paused,
}: {
  readonly recovery: ProviderRecoveryView | null
  readonly nowMs: number
  readonly paused: boolean
}) {
  if (recovery === null) {
    return null
  }
  const episode = snapshotFromView(recovery)
  if (paused) {
    if (episode.status !== "cancelled" && episode.status !== "scheduled") {
      return null
    }
    return (
      <p
        className={ui.statusMessage}
        data-provider-recovery="paused"
        role="status"
      >
        {PROVIDER_RECOVERY_PAUSED_MESSAGE}
      </p>
    )
  }
  if (episode.status === "exhausted") {
    return (
      <div data-provider-recovery="exhausted">
        <Banner
          className={ui.bannerCompact}
          tone="alarm"
          tag="Provider"
          role="status"
        >
          {PROVIDER_RECOVERY_EXHAUSTED_MESSAGE}
        </Banner>
      </div>
    )
  }
  if (episode.status === "recovered") {
    return (
      <p
        className={ui.statusMessage}
        data-provider-recovery="recovered"
        role="status"
      >
        {PROVIDER_RECOVERY_RECOVERED_MESSAGE}
      </p>
    )
  }
  if (episode.status === "in_attempt") {
    return (
      <div data-provider-recovery="retrying">
        <p className={ui.statusMessage} role="status">
          {PROVIDER_RECOVERY_RETRYING_MESSAGE}
        </p>
        {episode.escalated ? (
          <div data-provider-recovery-escalation="true">
            <Banner
              className={ui.bannerCompact}
              tone="guidance"
              tag="Provider"
              role="status"
            >
              {PROVIDER_RECOVERY_ESCALATION_MESSAGE}
            </Banner>
          </div>
        ) : null}
      </div>
    )
  }
  if (episode.status !== "scheduled") {
    return null
  }

  const model = formatProviderRecoveryModel(episode)
  const elapsed = formatProviderRecoveryElapsed(
    Math.max(0, nowMs - episode.episodeStartedAt),
  )
  const next =
    episode.nextAttemptAt === null
      ? null
      : new Date(episode.nextAttemptAt).toISOString()
  return (
    <div data-provider-recovery="waiting">
      <p className={ui.statusMessage} role="status">
        {formatProviderRecoveryWaitingHeadline({ episode, nowMs })}
      </p>
      <ul className="mt-1 mb-0 list-none p-0 font-mono text-xs text-ink-2">
        {model !== null ? <li>Model {model}</li> : null}
        <li>{attemptLabel(episode.attemptCount)}</li>
        <li>Waiting {elapsed}</li>
        {episode.reasonMessage !== null && episode.reasonMessage !== "" ? (
          <li>Last cause: {episode.reasonMessage}</li>
        ) : null}
        {next !== null ? <li>Next attempt {next}</li> : null}
      </ul>
      <p className={ui.dialogFieldHint}>{PROVIDER_RECOVERY_CONTROLS_MESSAGE}</p>
      {episode.escalated ? (
        <div data-provider-recovery-escalation="true">
          <Banner
            className={ui.bannerCompact}
            tone="guidance"
            tag="Provider"
            role="status"
          >
            {PROVIDER_RECOVERY_ESCALATION_MESSAGE}
          </Banner>
        </div>
      ) : null}
    </div>
  )
}

export const providerRecoveryReplacesStatusMessage = (
  recovery: ProviderRecoveryView | null | undefined,
  paused: boolean,
): boolean => {
  if (recovery == null) {
    return false
  }
  if (paused) {
    return recovery.status === "CANCELLED" || recovery.status === "SCHEDULED"
  }
  return (
    recovery.status === "SCHEDULED" ||
    recovery.status === "IN_ATTEMPT" ||
    recovery.status === "EXHAUSTED"
  )
}

export const providerRecoveryWarningOpen = (
  recovery: ProviderRecoveryView | null,
): boolean => {
  if (recovery === null || !recovery.escalated) {
    return false
  }
  return providerRecoveryIsOpen(snapshotFromView(recovery))
}
