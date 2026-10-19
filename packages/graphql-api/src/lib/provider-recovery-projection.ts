import type { ProviderRecoveryEpisodeRecord } from "@ready-for-agent/db-service"
import type {
  ProviderRecoverySnapshot,
  WorkItemRecord,
} from "@ready-for-agent/work-item-lifecycle"

type WorkItemWithProviderRecovery = WorkItemRecord & {
  readonly providerRecoveryEpisode: ProviderRecoveryEpisodeRecord | null
}

export const toProviderRecoverySnapshot = (
  record: ProviderRecoveryEpisodeRecord | null,
): ProviderRecoverySnapshot | null => {
  if (record === null) {
    return null
  }
  return {
    status: record.status,
    lifecycleStep: record.lifecycleStep,
    providerId: record.providerId,
    providerLabel: record.providerLabel,
    model: record.model,
    providerCode: record.providerCode,
    reasonMessage: record.reasonMessage,
    episodeStartedAt: record.episodeStartedAt,
    attemptCount: record.attemptCount,
    nextAttemptAt: record.nextAttemptAt,
    escalated: record.escalated,
    exhaustedAt: record.exhaustedAt,
  }
}

export const attachProviderRecovery = <T extends { readonly id: string }>(
  workItems: readonly T[],
  episodes: readonly ProviderRecoveryEpisodeRecord[],
): Array<
  T & { readonly providerRecoveryEpisode: ProviderRecoveryEpisodeRecord | null }
> => {
  const byWorkItemId = new Map(
    episodes.map((episode) => [episode.workItemId, episode]),
  )
  return workItems.map((workItem) => ({
    ...workItem,
    providerRecoveryEpisode: byWorkItemId.get(workItem.id) ?? null,
  }))
}

const iso = (millis: number | null): string | null =>
  millis === null ? null : new Date(millis).toISOString()

export const toGraphqlProviderRecovery = (
  record: ProviderRecoveryEpisodeRecord | null,
) => {
  if (record === null) {
    return null
  }
  return {
    status: record.status.toUpperCase(),
    lifecycleStep: record.lifecycleStep,
    providerId: record.providerId,
    providerLabel: record.providerLabel,
    model: record.model,
    providerCode: record.providerCode,
    reasonMessage: record.reasonMessage,
    episodeStartedAt: new Date(record.episodeStartedAt).toISOString(),
    attemptCount: record.attemptCount,
    nextAttemptAt: iso(record.nextAttemptAt),
    escalated: record.escalated,
    exhaustedAt: iso(record.exhaustedAt),
  }
}

export const attachedProviderRecovery = (
  workItem: WorkItemRecord,
): ProviderRecoveryEpisodeRecord | null | undefined => {
  if (!Object.hasOwn(workItem, "providerRecoveryEpisode")) {
    return undefined
  }
  return (workItem as WorkItemWithProviderRecovery).providerRecoveryEpisode
}
