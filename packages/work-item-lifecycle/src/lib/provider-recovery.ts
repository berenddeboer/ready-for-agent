import { Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { AgentBackendProvider } from "@ready-for-agent/agent-backend"
import type { QueueServiceShape } from "@ready-for-agent/queue-service"
import {
  coordinateProviderRecoverySchedule,
  settleProviderRecoveryCooldown,
} from "./provider-recovery-cooldown.js"
import {
  PROVIDER_RECOVERY_ESCALATION_AFTER_MS,
  providerRecoveryElapsedExceedsMax,
  providerRecoveryJitterSeed,
  scheduleProviderRecovery,
} from "./provider-recovery-policy.js"

export const TRANSIENT_PROVIDER_ERROR_REASON = "transient_provider_error"
const PROVIDER_RECOVERY_EXHAUSTED_REASON = "provider_recovery_exhausted"

const OPEN_STATUSES = ["scheduled", "in_attempt"] as const

export type ProviderRecoveryEpisodeRow = {
  readonly id: string
  readonly work_item_id: string
  readonly lifecycle_step: string
  readonly status: string
  readonly provider_id: string | null
  readonly provider_label: string | null
  readonly model: string | null
  readonly provider_code: string | null
  readonly reason_message: string | null
  readonly episode_started_at: number
  readonly attempt_count: number
  readonly next_attempt_at: number | null
  readonly generation: number
  readonly escalated: number | boolean
  readonly exhausted_at: number | null
}

export type TransientProviderFailurePlan =
  | { readonly _tag: "skip" }
  | {
      readonly _tag: "schedule"
      readonly reasonCode: typeof TRANSIENT_PROVIDER_ERROR_REASON
      readonly nextAttemptAt: number
      readonly generation: number
      readonly escalated: boolean
      readonly attemptCount: number
      readonly episodeStartedAt: number
      readonly providerId: string | null
      readonly providerLabel: string | null
      readonly model: string | null
      readonly providerCode: string | null
      readonly reasonMessage: string
    }
  | {
      readonly _tag: "exhaust"
      readonly reasonCode: typeof PROVIDER_RECOVERY_EXHAUSTED_REASON
      readonly attemptCount: number
      readonly episodeStartedAt: number
      readonly escalated: boolean
      readonly providerId: string | null
      readonly providerLabel: string | null
      readonly model: string | null
      readonly providerCode: string | null
      readonly reasonMessage: string
    }

const episodeSelect = `id, work_item_id, lifecycle_step, status, provider_id,
  provider_label, model, provider_code, reason_message, episode_started_at,
  attempt_count, next_attempt_at, generation, escalated, exhausted_at`

export const loadProviderRecoveryEpisode = (
  sql: SqlClient,
  workItemId: string,
) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT ${episodeSelect}
       FROM provider_recovery_episode
       WHERE work_item_id = ?`,
      [workItemId],
    )) as readonly ProviderRecoveryEpisodeRow[]
    return rows[0] ?? null
  })

export const readProviderRecoveryMaxWaitMs = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT provider_recovery_max_wait_ms AS max_wait_ms
       FROM config
       WHERE id = 'default'`,
    )) as readonly { readonly max_wait_ms: number | null }[]
    const value = rows[0]?.max_wait_ms
    return typeof value === "number" && Number.isFinite(value) ? value : null
  })

export const closeOpenProviderRecovery = (
  sql: SqlClient,
  workItemId: string,
  now: number,
  status: "cancelled" | "exited" | "recovered",
  queue?: QueueServiceShape,
) =>
  Effect.gen(function* () {
    yield* sql.unsafe(
      `UPDATE provider_recovery_episode
       SET status = ?,
           next_attempt_at = NULL,
           generation = generation + 1,
           updated_at = ?
       WHERE work_item_id = ?
         AND status IN ('scheduled', 'in_attempt')`,
      [status, now, workItemId],
    )
    if (queue === undefined) {
      return
    }
    const maxWaitMs = yield* readProviderRecoveryMaxWaitMs(sql)
    yield* settleProviderRecoveryCooldown({
      sql,
      queue,
      workItemId,
      now,
      outcome: status,
      maxWaitMs,
    })
  })

/**
 * Manual Retry keeps the episode so a later transient failure continues the
 * same outage, but invalidates any outstanding wake before the new Step Run
 * exists.
 */
export const supersedeProviderRecoveryWake = (
  sql: SqlClient,
  workItemId: string,
  now: number,
) =>
  sql.unsafe(
    `UPDATE provider_recovery_episode
     SET status = 'in_attempt',
         next_attempt_at = NULL,
         generation = generation + 1,
         updated_at = ?
     WHERE work_item_id = ?
       AND status = 'scheduled'`,
    [now, workItemId],
  )

const isOpen = (episode: ProviderRecoveryEpisodeRow | null): boolean =>
  episode !== null &&
  (OPEN_STATUSES as readonly string[]).includes(episode.status)

export const planTransientProviderFailure = (input: {
  readonly now: number
  readonly workItemId: string
  readonly paused: boolean
  readonly episode: ProviderRecoveryEpisodeRow | null
  readonly maxWaitMs: number | null
  readonly providerRetryAt: number | null
  readonly provider: AgentBackendProvider | null
  readonly model: string | null
  readonly providerCode: string | null
  readonly reasonMessage: string
}): TransientProviderFailurePlan => {
  if (input.paused) {
    return { _tag: "skip" }
  }
  const continuing = isOpen(input.episode) ? input.episode : null
  const episodeStartedAt = continuing?.episode_started_at ?? input.now
  const attemptCount = (continuing?.attempt_count ?? 0) + 1
  const scheduled = scheduleProviderRecovery({
    now: input.now,
    attempt: attemptCount,
    episodeStartedAt,
    providerRetryAt: input.providerRetryAt,
    maxWaitMs: input.maxWaitMs,
    jitterSeed: providerRecoveryJitterSeed({
      workItemId: input.workItemId,
      episodeStartedAt,
      attempt: attemptCount,
    }),
  })
  const identity = {
    providerId: input.provider?.id ?? continuing?.provider_id ?? null,
    providerLabel: input.provider?.label ?? continuing?.provider_label ?? null,
    model: input.model ?? continuing?.model ?? null,
    providerCode: input.providerCode ?? continuing?.provider_code ?? null,
    reasonMessage: input.reasonMessage,
    attemptCount,
    episodeStartedAt,
    escalated:
      scheduled._tag === "schedule"
        ? scheduled.escalated || Boolean(continuing?.escalated)
        : input.now - episodeStartedAt >=
            PROVIDER_RECOVERY_ESCALATION_AFTER_MS ||
          Boolean(continuing?.escalated),
  }
  if (scheduled._tag === "exhaust") {
    return {
      _tag: "exhaust",
      reasonCode: PROVIDER_RECOVERY_EXHAUSTED_REASON,
      ...identity,
    }
  }
  return {
    _tag: "schedule",
    reasonCode: TRANSIENT_PROVIDER_ERROR_REASON,
    nextAttemptAt: scheduled.nextAttemptAt,
    generation: (continuing?.generation ?? 0) + 1,
    ...identity,
    escalated: scheduled.escalated || Boolean(continuing?.escalated),
  }
}

export const applyTransientProviderFailurePlan = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly workItemId: string
  readonly step: string
  readonly now: number
  readonly backend: string
  readonly accountId: string | null
  readonly maxWaitMs: number | null
  readonly providerRetryAt: number | null
  readonly plan: TransientProviderFailurePlan
}) =>
  Effect.gen(function* () {
    const { plan } = input
    if (plan._tag === "skip") {
      return
    }
    yield* coordinateProviderRecoverySchedule({
      sql: input.sql,
      queue: input.queue,
      now: input.now,
      workItemId: input.workItemId,
      step: input.step,
      backend: input.backend,
      accountId: input.accountId,
      maxWaitMs: input.maxWaitMs,
      providerRetryAt: input.providerRetryAt,
      plan,
    })
  })

export type ProviderRecoveryWakeResult =
  | { readonly _tag: "woke" }
  | { readonly _tag: "stale" }
  | { readonly _tag: "not_due" }
  | { readonly _tag: "exhausted" }
  | { readonly _tag: "deferred" }

/**
 * Claim a due wake and re-enter ordinary admission. The claim bumps generation
 * so a competing wake or a manual Retry that already superseded this deadline
 * cannot enqueue a second Step Run.
 */
export const claimProviderRecoveryWake = (input: {
  readonly sql: SqlClient
  readonly workItemId: string
  readonly generation: number
  readonly nextAttemptAt: number
  readonly now: number
  readonly maxWaitMs: number | null
}) =>
  Effect.gen(function* () {
    if (input.nextAttemptAt > input.now) {
      return { _tag: "not_due" as const }
    }
    const current = yield* loadProviderRecoveryEpisode(
      input.sql,
      input.workItemId,
    )
    if (
      current === null ||
      current.status !== "scheduled" ||
      current.generation !== input.generation ||
      current.next_attempt_at !== input.nextAttemptAt
    ) {
      return { _tag: "stale" as const }
    }
    if (
      providerRecoveryElapsedExceedsMax({
        now: input.now,
        episodeStartedAt: current.episode_started_at,
        maxWaitMs: input.maxWaitMs,
      })
    ) {
      yield* input.sql.unsafe(
        `UPDATE provider_recovery_episode
         SET status = 'exhausted',
             next_attempt_at = NULL,
             generation = generation + 1,
             exhausted_at = ?,
             escalated = CASE
               WHEN ? - episode_started_at >= ${PROVIDER_RECOVERY_ESCALATION_AFTER_MS} THEN 1
               ELSE escalated
             END,
             updated_at = ?
         WHERE id = ?
           AND status = 'scheduled'
           AND generation = ?`,
        [input.now, input.now, input.now, current.id, input.generation],
      )
      return { _tag: "exhausted" as const }
    }
    const claimed = (yield* input.sql.unsafe(
      `UPDATE provider_recovery_episode
       SET status = 'in_attempt',
           next_attempt_at = NULL,
           generation = generation + 1,
           escalated = CASE
             WHEN ? - episode_started_at >= ${PROVIDER_RECOVERY_ESCALATION_AFTER_MS} THEN 1
             ELSE escalated
           END,
           updated_at = ?
       WHERE id = ?
         AND status = 'scheduled'
         AND generation = ?
         AND next_attempt_at = ?
       RETURNING lifecycle_step`,
      [input.now, input.now, current.id, input.generation, input.nextAttemptAt],
    )) as readonly { readonly lifecycle_step: string }[]
    const step = claimed[0]?.lifecycle_step
    if (step === undefined) {
      return { _tag: "stale" as const }
    }
    return { _tag: "claimed" as const, step }
  })
