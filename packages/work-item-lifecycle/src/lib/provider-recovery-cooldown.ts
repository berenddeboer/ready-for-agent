import { Duration, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { TERMINAL_WORK_ITEM_STATES } from "@ready-for-agent/lifecycle-model"
import type { QueueServiceShape } from "@ready-for-agent/queue-service"
import {
  alignRecoveryAttempt,
  providerRecoveryFollowerOffsetMs,
  providerRecoveryScopeKey,
  providerRecoveryScopeKind,
  safeProviderAccountIdentity,
} from "./provider-recovery-scope.js"
import {
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemProviderRecoveryJob,
  makeProviderRecoveryCooldownId,
  makeProviderRecoveryId,
} from "./types.js"

type RecoveryPlanIdentity = {
  readonly providerId: string | null
  readonly providerLabel: string | null
  readonly model: string | null
  readonly providerCode: string | null
  readonly reasonMessage: string
  readonly attemptCount: number
  readonly episodeStartedAt: number
  readonly escalated: boolean
}

export type CoordinatedRecoveryPlan =
  | (RecoveryPlanIdentity & {
      readonly _tag: "schedule"
      readonly nextAttemptAt: number
      readonly generation: number
    })
  | (RecoveryPlanIdentity & { readonly _tag: "exhaust" })

const OPEN_EPISODE = `('scheduled', 'in_attempt')`

type CooldownRow = {
  readonly id: string
  readonly scope_key: string
  readonly next_attempt_at: number | null
  readonly probe_work_item_id: string | null
  readonly generation: number
}

type OpenEpisodeRow = {
  readonly work_item_id: string
  readonly status: string
  readonly episode_started_at: number
  readonly next_attempt_at: number | null
  readonly generation: number
}

const enqueueRecoveryWake = (input: {
  readonly queue: QueueServiceShape
  readonly workItemId: string
  readonly generation: number
  readonly nextAttemptAt: number
  readonly now: number
}) =>
  Effect.gen(function* () {
    const payload = yield* Schema.decodeUnknownEffect(
      WorkItemProviderRecoveryJob,
    )({
      _tag: "work-item-provider-recovery",
      workItemId: input.workItemId,
      generation: input.generation,
      nextAttemptAt: input.nextAttemptAt,
    })
    yield* input.queue.enqueueWithDelay(
      WORK_ITEM_LIFECYCLE_QUEUE,
      payload,
      Duration.millis(Math.max(0, input.nextAttemptAt - input.now)),
      { retryLimit: 1 },
    )
  })

const loadCooldown = (sql: SqlClient, cooldownId: string) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT id, scope_key, next_attempt_at, probe_work_item_id, generation
       FROM provider_recovery_cooldown
       WHERE id = ?`,
      [cooldownId],
    )) as readonly CooldownRow[]
    return rows[0] ?? null
  })

const isValidProbeOwner = (sql: SqlClient, workItemId: string) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT e.status AS episode_status,
              w.paused AS paused,
              w.waiting_since AS waiting_since,
              w.waiting_for_blockers AS waiting_for_blockers,
              w.waiting_for_ci_repair AS waiting_for_ci_repair,
              w.state AS state,
              (
                SELECT COUNT(*) FROM step_run s
                WHERE s.work_item_id = w.id
                  AND s.status IN ('queued', 'running')
              ) AS active_steps
       FROM provider_recovery_episode e
       JOIN work_item w ON w.id = e.work_item_id
       WHERE e.work_item_id = ?`,
      [workItemId],
    )) as readonly {
      readonly episode_status: string
      readonly paused: number | boolean
      readonly waiting_since: number | null
      readonly waiting_for_blockers: number | boolean
      readonly waiting_for_ci_repair: number | boolean
      readonly state: string
      readonly active_steps: number
    }[]
    const row = rows[0]
    if (row === undefined) {
      return false
    }
    if (row.paused || row.waiting_for_blockers || row.waiting_for_ci_repair) {
      return false
    }
    if ((TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(row.state)) {
      return false
    }
    if (row.episode_status === "scheduled") {
      return true
    }
    if (row.episode_status !== "in_attempt") {
      return false
    }
    if (Number(row.active_steps) > 0) {
      return true
    }
    return row.waiting_since !== null && row.waiting_since !== undefined
  })

const clearAbandonedProbe = (sql: SqlClient, cooldownId: string, now: number) =>
  Effect.gen(function* () {
    const cooldown = yield* loadCooldown(sql, cooldownId)
    const owner = cooldown?.probe_work_item_id
    if (owner === null || owner === undefined) {
      return
    }
    if (yield* isValidProbeOwner(sql, owner)) {
      return
    }
    yield* sql.unsafe(
      `UPDATE provider_recovery_cooldown
       SET probe_work_item_id = NULL,
           probe_claimed_at = NULL,
           updated_at = ?
       WHERE id = ?
         AND probe_work_item_id = ?`,
      [now, cooldownId, owner],
    )
  })

const loadOpenEpisodes = (sql: SqlClient, cooldownId: string) =>
  Effect.gen(function* () {
    return (yield* sql.unsafe(
      `SELECT work_item_id, status, episode_started_at, next_attempt_at, generation
       FROM provider_recovery_episode
       WHERE cooldown_id = ?
         AND status IN ${OPEN_EPISODE}
       ORDER BY work_item_id ASC`,
      [cooldownId],
    )) as readonly OpenEpisodeRow[]
  })

const exhaustEpisode = (sql: SqlClient, workItemId: string, now: number) =>
  sql.unsafe(
    `UPDATE provider_recovery_episode
     SET status = 'exhausted',
         next_attempt_at = NULL,
         generation = generation + 1,
         exhausted_at = ?,
         updated_at = ?
     WHERE work_item_id = ?
       AND status IN ${OPEN_EPISODE}`,
    [now, now, workItemId],
  )

const deleteCooldownIfIdle = (sql: SqlClient, cooldownId: string) =>
  sql.unsafe(
    `DELETE FROM provider_recovery_cooldown
     WHERE id = ?
       AND NOT EXISTS (
         SELECT 1 FROM provider_recovery_episode
         WHERE cooldown_id = ?
           AND status IN ${OPEN_EPISODE}
       )`,
    [cooldownId, cooldownId],
  )

const upsertEpisode = (
  sql: SqlClient,
  input: {
    readonly workItemId: string
    readonly step: string
    readonly status: string
    readonly now: number
    readonly episodeStartedAt: number
    readonly attemptCount: number
    readonly nextAttemptAt: number | null
    readonly generation: number
    readonly escalated: boolean
    readonly exhaustedAt: number | null
    readonly providerId: string | null
    readonly providerLabel: string | null
    readonly model: string | null
    readonly providerCode: string | null
    readonly reasonMessage: string
    readonly cooldownId: string | null
  },
) =>
  sql.unsafe(
    `INSERT INTO provider_recovery_episode (
       id, work_item_id, lifecycle_step, status, provider_id, provider_label,
       model, provider_code, reason_message, episode_started_at, attempt_count,
       next_attempt_at, generation, escalated, exhausted_at, cooldown_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET
       lifecycle_step = excluded.lifecycle_step,
       status = excluded.status,
       provider_id = excluded.provider_id,
       provider_label = excluded.provider_label,
       model = excluded.model,
       provider_code = excluded.provider_code,
       reason_message = excluded.reason_message,
       episode_started_at = excluded.episode_started_at,
       attempt_count = excluded.attempt_count,
       next_attempt_at = excluded.next_attempt_at,
       generation = excluded.generation,
       escalated = excluded.escalated,
       exhausted_at = excluded.exhausted_at,
       cooldown_id = COALESCE(excluded.cooldown_id, provider_recovery_episode.cooldown_id),
       updated_at = excluded.updated_at`,
    [
      makeProviderRecoveryId(),
      input.workItemId,
      input.step,
      input.status,
      input.providerId,
      input.providerLabel,
      input.model,
      input.providerCode,
      input.reasonMessage,
      input.episodeStartedAt,
      input.attemptCount,
      input.nextAttemptAt,
      input.generation,
      input.escalated ? 1 : 0,
      input.exhaustedAt,
      input.cooldownId,
      input.now,
      input.now,
    ],
  )

const ensureCooldown = (input: {
  readonly sql: SqlClient
  readonly now: number
  readonly scopeKey: string
  readonly scopeKind: "model" | "provider"
  readonly backend: string
  readonly providerId: string | null
  readonly accountId: string | null
  readonly model: string | null
}) =>
  Effect.gen(function* () {
    const rows = (yield* input.sql.unsafe(
      `INSERT INTO provider_recovery_cooldown (
         id, scope_key, scope_kind, backend, provider_id, account_id, model,
         next_attempt_at, probe_work_item_id, probe_claimed_at, generation,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET updated_at = excluded.updated_at
       RETURNING id, scope_key, next_attempt_at, probe_work_item_id, generation`,
      [
        makeProviderRecoveryCooldownId(),
        input.scopeKey,
        input.scopeKind,
        input.backend,
        input.providerId,
        input.accountId,
        input.model,
        input.now,
        input.now,
      ],
    )) as readonly CooldownRow[]
    const row = rows[0]
    if (row === undefined) {
      return yield* Effect.die(
        "Provider Recovery Cooldown insert returned no row",
      )
    }
    return row
  })

const writeCooldownLease = (
  sql: SqlClient,
  input: {
    readonly cooldownId: string
    readonly now: number
    readonly nextAttemptAt: number | null
    readonly probeWorkItemId: string | null
    readonly claimed: boolean
  },
) =>
  sql.unsafe(
    `UPDATE provider_recovery_cooldown
     SET next_attempt_at = ?,
         probe_work_item_id = ?,
         probe_claimed_at = CASE
           WHEN ? = 1 THEN ?
           WHEN probe_work_item_id = ? THEN probe_claimed_at
           ELSE NULL
         END,
         generation = generation + 1,
         updated_at = ?
     WHERE id = ?`,
    [
      input.nextAttemptAt,
      input.probeWorkItemId,
      input.claimed ? 1 : 0,
      input.now,
      input.probeWorkItemId,
      input.now,
      input.cooldownId,
    ],
  )

const scheduleEpisode = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly now: number
  readonly workItemId: string
  readonly generation: number
  readonly nextAttemptAt: number
}) =>
  Effect.gen(function* () {
    yield* input.sql.unsafe(
      `UPDATE provider_recovery_episode
       SET status = 'scheduled',
           next_attempt_at = ?,
           generation = ?,
           updated_at = ?
       WHERE work_item_id = ?
         AND status IN ${OPEN_EPISODE}`,
      [input.nextAttemptAt, input.generation, input.now, input.workItemId],
    )
    yield* enqueueRecoveryWake(input)
  })

const realignOpenEpisodes = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly cooldownId: string
  readonly now: number
  readonly sharedDeadline: number
  readonly maxWaitMs: number | null
  readonly excludeWorkItemId: string
  readonly probeWorkItemId: string | null
}) =>
  Effect.gen(function* () {
    const open = yield* loadOpenEpisodes(input.sql, input.cooldownId)
    const followers = open.filter(
      (row) =>
        row.work_item_id !== input.excludeWorkItemId &&
        row.work_item_id !== input.probeWorkItemId &&
        row.status === "scheduled",
    )
    const delayMs = Math.max(60_000, input.sharedDeadline - input.now)
    let rank = 0
    for (const follower of followers) {
      rank += 1
      const aligned = alignRecoveryAttempt({
        now: input.now,
        episodeStartedAt: follower.episode_started_at,
        maxWaitMs: input.maxWaitMs,
        individualNextAttemptAt:
          follower.next_attempt_at ?? input.sharedDeadline,
        sharedDeadline: input.sharedDeadline,
        role: "follower",
        followerOffsetMs: providerRecoveryFollowerOffsetMs({
          rank,
          population: followers.length,
          delayMs,
        }),
      })
      if (aligned._tag === "exhaust") {
        yield* exhaustEpisode(input.sql, follower.work_item_id, input.now)
        continue
      }
      yield* scheduleEpisode({
        sql: input.sql,
        queue: input.queue,
        now: input.now,
        workItemId: follower.work_item_id,
        generation: follower.generation + 1,
        nextAttemptAt: aligned.nextAttemptAt,
      })
    }
    if (
      input.probeWorkItemId !== null &&
      input.probeWorkItemId !== input.excludeWorkItemId
    ) {
      const probe = open.find(
        (row) => row.work_item_id === input.probeWorkItemId,
      )
      if (probe?.status === "scheduled") {
        const aligned = alignRecoveryAttempt({
          now: input.now,
          episodeStartedAt: probe.episode_started_at,
          maxWaitMs: input.maxWaitMs,
          individualNextAttemptAt: input.sharedDeadline,
          sharedDeadline: input.sharedDeadline,
          role: "probe",
          followerOffsetMs: 0,
        })
        if (aligned._tag === "exhaust") {
          yield* exhaustEpisode(input.sql, probe.work_item_id, input.now)
          yield* input.sql.unsafe(
            `UPDATE provider_recovery_cooldown
             SET probe_work_item_id = NULL, probe_claimed_at = NULL, updated_at = ?
             WHERE id = ? AND probe_work_item_id = ?`,
            [input.now, input.cooldownId, probe.work_item_id],
          )
        } else if (probe.next_attempt_at !== aligned.nextAttemptAt) {
          yield* scheduleEpisode({
            sql: input.sql,
            queue: input.queue,
            now: input.now,
            workItemId: probe.work_item_id,
            generation: probe.generation + 1,
            nextAttemptAt: aligned.nextAttemptAt,
          })
        }
      }
    }
  })

const promoteNextProbe = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly cooldownId: string
  readonly now: number
  readonly excludeWorkItemId: string | null
  readonly maxWaitMs: number | null
}) =>
  Effect.gen(function* () {
    const cooldown = yield* loadCooldown(input.sql, input.cooldownId)
    if (cooldown === null) {
      return
    }
    yield* clearAbandonedProbe(input.sql, input.cooldownId, input.now)
    const current = yield* loadCooldown(input.sql, input.cooldownId)
    if (
      current?.probe_work_item_id !== null &&
      current?.probe_work_item_id !== undefined &&
      current.probe_work_item_id !== input.excludeWorkItemId &&
      (yield* isValidProbeOwner(input.sql, current.probe_work_item_id))
    ) {
      return
    }
    const open = yield* loadOpenEpisodes(input.sql, input.cooldownId)
    const deadline = Math.max(input.now, cooldown.next_attempt_at ?? input.now)
    const candidates = open
      .filter(
        (row) =>
          row.status === "scheduled" &&
          row.work_item_id !== input.excludeWorkItemId,
      )
      .sort((left, right) => {
        const leftAt = left.next_attempt_at ?? deadline
        const rightAt = right.next_attempt_at ?? deadline
        return (
          leftAt - rightAt ||
          left.work_item_id.localeCompare(right.work_item_id)
        )
      })
    for (const candidate of candidates) {
      if (!(yield* isValidProbeOwner(input.sql, candidate.work_item_id))) {
        continue
      }
      const aligned = alignRecoveryAttempt({
        now: input.now,
        episodeStartedAt: candidate.episode_started_at,
        maxWaitMs: input.maxWaitMs,
        individualNextAttemptAt: deadline,
        sharedDeadline: deadline,
        role: "probe",
        followerOffsetMs: 0,
      })
      if (aligned._tag === "exhaust") {
        yield* exhaustEpisode(input.sql, candidate.work_item_id, input.now)
        continue
      }
      yield* writeCooldownLease(input.sql, {
        cooldownId: input.cooldownId,
        now: input.now,
        nextAttemptAt: aligned.nextAttemptAt,
        probeWorkItemId: candidate.work_item_id,
        claimed: false,
      })
      yield* scheduleEpisode({
        sql: input.sql,
        queue: input.queue,
        now: input.now,
        workItemId: candidate.work_item_id,
        generation: candidate.generation + 1,
        nextAttemptAt: aligned.nextAttemptAt,
      })
      return
    }
    yield* deleteCooldownIfIdle(input.sql, input.cooldownId)
  })

const releaseFollowers = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly cooldownId: string
  readonly now: number
  readonly maxWaitMs: number | null
}) =>
  Effect.gen(function* () {
    const open = (yield* loadOpenEpisodes(input.sql, input.cooldownId)).filter(
      (row) => row.status === "scheduled",
    )
    let rank = 0
    for (const follower of open) {
      rank += 1
      const offset = providerRecoveryFollowerOffsetMs({
        rank,
        population: open.length,
        delayMs: 60_000,
      })
      const nextAttemptAt = input.now + offset
      if (
        input.maxWaitMs !== null &&
        nextAttemptAt - follower.episode_started_at >= input.maxWaitMs
      ) {
        yield* exhaustEpisode(input.sql, follower.work_item_id, input.now)
        continue
      }
      const generation = follower.generation + 1
      yield* input.sql.unsafe(
        `UPDATE provider_recovery_episode
         SET status = 'scheduled',
             next_attempt_at = ?,
             generation = ?,
             cooldown_id = NULL,
             updated_at = ?
         WHERE work_item_id = ?`,
        [nextAttemptAt, generation, input.now, follower.work_item_id],
      )
      yield* enqueueRecoveryWake({
        queue: input.queue,
        workItemId: follower.work_item_id,
        generation,
        nextAttemptAt,
        now: input.now,
      })
    }
    yield* input.sql.unsafe(
      `DELETE FROM provider_recovery_cooldown WHERE id = ?`,
      [input.cooldownId],
    )
  })

const cooldownIdForWorkItem = (sql: SqlClient, workItemId: string) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT cooldown_id FROM provider_recovery_episode WHERE work_item_id = ?`,
      [workItemId],
    )) as readonly { readonly cooldown_id: string | null }[]
    return rows[0]?.cooldown_id ?? null
  })

/**
 * Record one classified transient failure on the shared cooldown. A failed
 * probe extends the shared deadline. A joiner shares that deadline instead of
 * starting its own burst, and a later provider deadline can push the floor
 * out but a joiner's own backoff cannot.
 */
export const coordinateProviderRecoverySchedule = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly now: number
  readonly workItemId: string
  readonly step: string
  readonly backend: string
  readonly accountId: string | null
  readonly maxWaitMs: number | null
  readonly providerRetryAt: number | null
  readonly plan: CoordinatedRecoveryPlan
}) =>
  Effect.gen(function* () {
    const { plan } = input
    const kind = providerRecoveryScopeKind(plan.providerCode)
    const accountId = safeProviderAccountIdentity(input.accountId)
    const scopeKey = providerRecoveryScopeKey({
      backend: input.backend,
      providerId: plan.providerId,
      accountId,
      model: plan.model,
      kind,
    })
    const persistedModel = kind === "provider" ? null : plan.model
    const previousCooldownId = yield* cooldownIdForWorkItem(
      input.sql,
      input.workItemId,
    )
    const cooldown = yield* ensureCooldown({
      sql: input.sql,
      now: input.now,
      scopeKey,
      scopeKind: kind,
      backend: input.backend,
      providerId: plan.providerId,
      accountId,
      model: persistedModel,
    })
    if (previousCooldownId !== null && previousCooldownId !== cooldown.id) {
      yield* input.sql.unsafe(
        `UPDATE provider_recovery_cooldown
         SET probe_work_item_id = NULL, probe_claimed_at = NULL, updated_at = ?
         WHERE id = ? AND probe_work_item_id = ?`,
        [input.now, previousCooldownId, input.workItemId],
      )
      yield* promoteNextProbe({
        sql: input.sql,
        queue: input.queue,
        cooldownId: previousCooldownId,
        now: input.now,
        excludeWorkItemId: input.workItemId,
        maxWaitMs: input.maxWaitMs,
      })
      yield* deleteCooldownIfIdle(input.sql, previousCooldownId)
    }
    yield* clearAbandonedProbe(input.sql, cooldown.id, input.now)
    const current = (yield* loadCooldown(input.sql, cooldown.id)) ?? cooldown

    if (plan._tag === "exhaust") {
      yield* upsertEpisode(input.sql, {
        workItemId: input.workItemId,
        step: input.step,
        status: "exhausted",
        now: input.now,
        episodeStartedAt: plan.episodeStartedAt,
        attemptCount: plan.attemptCount,
        nextAttemptAt: null,
        generation: 0,
        escalated: plan.escalated,
        exhaustedAt: input.now,
        providerId: plan.providerId,
        providerLabel: plan.providerLabel,
        model: plan.model,
        providerCode: plan.providerCode,
        reasonMessage: plan.reasonMessage,
        cooldownId: current.id,
      })
      if (current.probe_work_item_id === input.workItemId) {
        yield* input.sql.unsafe(
          `UPDATE provider_recovery_cooldown
           SET probe_work_item_id = NULL, probe_claimed_at = NULL, updated_at = ?
           WHERE id = ? AND probe_work_item_id = ?`,
          [input.now, current.id, input.workItemId],
        )
      }
      yield* promoteNextProbe({
        sql: input.sql,
        queue: input.queue,
        cooldownId: current.id,
        now: input.now,
        excludeWorkItemId: input.workItemId,
        maxWaitMs: input.maxWaitMs,
      })
      yield* deleteCooldownIfIdle(input.sql, current.id)
      return
    }

    const providerFloor =
      input.providerRetryAt !== null && Number.isFinite(input.providerRetryAt)
        ? input.providerRetryAt
        : null
    const existingFloor =
      current.next_attempt_at !== null && current.next_attempt_at > input.now
        ? current.next_attempt_at
        : null
    const isProbeFailure = current.probe_work_item_id === input.workItemId
    const probeStillValid =
      current.probe_work_item_id !== null &&
      current.probe_work_item_id !== input.workItemId &&
      (yield* isValidProbeOwner(input.sql, current.probe_work_item_id))
    const role = isProbeFailure || !probeStillValid ? "probe" : "follower"
    const sharedDeadline = isProbeFailure
      ? Math.max(plan.nextAttemptAt, providerFloor ?? plan.nextAttemptAt)
      : probeStillValid
        ? Math.max(
            existingFloor ?? current.next_attempt_at ?? input.now,
            providerFloor ?? 0,
          )
        : Math.max(plan.nextAttemptAt, providerFloor ?? plan.nextAttemptAt)
    const open = yield* loadOpenEpisodes(input.sql, current.id)
    const followerPopulation = Math.max(
      1,
      open.filter((row) => row.work_item_id !== input.workItemId).length +
        (role === "follower" ? 1 : 0),
    )
    const followerRank = Math.max(
      1,
      open.filter(
        (row) =>
          row.work_item_id !== input.workItemId &&
          row.work_item_id < input.workItemId,
      ).length + 1,
    )
    const aligned = alignRecoveryAttempt({
      now: input.now,
      episodeStartedAt: plan.episodeStartedAt,
      maxWaitMs: input.maxWaitMs,
      individualNextAttemptAt:
        role === "probe" ? sharedDeadline : plan.nextAttemptAt,
      sharedDeadline,
      role,
      followerOffsetMs:
        role === "probe"
          ? 0
          : providerRecoveryFollowerOffsetMs({
              rank: followerRank,
              population: followerPopulation,
              delayMs: Math.max(60_000, sharedDeadline - input.now),
            }),
    })
    if (aligned._tag === "exhaust") {
      yield* upsertEpisode(input.sql, {
        workItemId: input.workItemId,
        step: input.step,
        status: "exhausted",
        now: input.now,
        episodeStartedAt: plan.episodeStartedAt,
        attemptCount: plan.attemptCount,
        nextAttemptAt: null,
        generation: plan.generation,
        escalated: plan.escalated,
        exhaustedAt: input.now,
        providerId: plan.providerId,
        providerLabel: plan.providerLabel,
        model: plan.model,
        providerCode: plan.providerCode,
        reasonMessage: plan.reasonMessage,
        cooldownId: current.id,
      })
      yield* promoteNextProbe({
        sql: input.sql,
        queue: input.queue,
        cooldownId: current.id,
        now: input.now,
        excludeWorkItemId: input.workItemId,
        maxWaitMs: input.maxWaitMs,
      })
      yield* deleteCooldownIfIdle(input.sql, current.id)
      return
    }

    yield* upsertEpisode(input.sql, {
      workItemId: input.workItemId,
      step: input.step,
      status: "scheduled",
      now: input.now,
      episodeStartedAt: plan.episodeStartedAt,
      attemptCount: plan.attemptCount,
      nextAttemptAt: aligned.nextAttemptAt,
      generation: plan.generation,
      escalated: plan.escalated,
      exhaustedAt: null,
      providerId: plan.providerId,
      providerLabel: plan.providerLabel,
      model: plan.model,
      providerCode: plan.providerCode,
      reasonMessage: plan.reasonMessage,
      cooldownId: current.id,
    })
    const probeWorkItemId =
      role === "probe" ? input.workItemId : current.probe_work_item_id
    yield* writeCooldownLease(input.sql, {
      cooldownId: current.id,
      now: input.now,
      nextAttemptAt: sharedDeadline,
      probeWorkItemId,
      claimed: false,
    })
    yield* enqueueRecoveryWake({
      queue: input.queue,
      workItemId: input.workItemId,
      generation: plan.generation,
      nextAttemptAt: aligned.nextAttemptAt,
      now: input.now,
    })
    if (existingFloor !== sharedDeadline || isProbeFailure) {
      yield* realignOpenEpisodes({
        sql: input.sql,
        queue: input.queue,
        cooldownId: current.id,
        now: input.now,
        sharedDeadline,
        maxWaitMs: input.maxWaitMs,
        excludeWorkItemId: input.workItemId,
        probeWorkItemId,
      })
      const after = yield* loadCooldown(input.sql, current.id)
      if (after !== null && after.probe_work_item_id === null) {
        yield* promoteNextProbe({
          sql: input.sql,
          queue: input.queue,
          cooldownId: current.id,
          now: input.now,
          excludeWorkItemId: null,
          maxWaitMs: input.maxWaitMs,
        })
      }
    }
  })

/**
 * A claimed probe that is then held for a closed CI gate has no Step Run.
 * Return it to scheduled and let another eligible item probe. CI release must
 * not start this item outside the probe gate.
 */
export const parkClaimedProbeForCiHold = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly workItemId: string
  readonly now: number
  readonly maxWaitMs: number | null
}) =>
  Effect.gen(function* () {
    const parked = (yield* input.sql.unsafe(
      `UPDATE provider_recovery_episode
       SET status = 'scheduled',
           next_attempt_at = COALESCE(next_attempt_at, ?),
           updated_at = ?
       WHERE work_item_id = ?
         AND status = 'in_attempt'
         AND NOT EXISTS (
           SELECT 1 FROM step_run
           WHERE step_run.work_item_id = provider_recovery_episode.work_item_id
             AND step_run.status IN ('queued', 'running')
         )
       RETURNING cooldown_id`,
      [input.now, input.now, input.workItemId],
    )) as readonly { readonly cooldown_id: string | null }[]
    if (parked[0] === undefined) {
      return
    }
    yield* input.sql.unsafe(
      `UPDATE provider_recovery_cooldown
       SET probe_work_item_id = NULL,
           probe_claimed_at = NULL,
           updated_at = ?
       WHERE probe_work_item_id = ?`,
      [input.now, input.workItemId],
    )
    const cooldownId = parked[0].cooldown_id
    if (cooldownId === null) {
      return
    }
    yield* promoteNextProbe({
      sql: input.sql,
      queue: input.queue,
      cooldownId,
      now: input.now,
      excludeWorkItemId: input.workItemId,
      maxWaitMs: input.maxWaitMs,
    })
  })

/**
 * CI release must not enqueue a Step Run for an open Provider Recovery
 * episode. A due wake re-enters the probe gate instead.
 * Returns true when the caller should not admit the item itself.
 */
export const resumeProviderRecoveryAfterCiHold = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly workItemId: string
  readonly now: number
}) =>
  Effect.gen(function* () {
    const episodes = (yield* input.sql.unsafe(
      `SELECT status, generation, next_attempt_at
       FROM provider_recovery_episode
       WHERE work_item_id = ?
         AND status IN ${OPEN_EPISODE}`,
      [input.workItemId],
    )) as readonly {
      readonly status: string
      readonly generation: number
      readonly next_attempt_at: number | null
    }[]
    const episode = episodes[0]
    if (episode === undefined) {
      return false
    }
    const active = (yield* input.sql.unsafe(
      `SELECT id FROM step_run
       WHERE work_item_id = ?
         AND status IN ('queued', 'running')
       LIMIT 1`,
      [input.workItemId],
    )) as readonly { readonly id: string }[]
    if (active[0] !== undefined) {
      return false
    }
    const nextAttemptAt =
      episode.next_attempt_at !== null && episode.next_attempt_at > input.now
        ? episode.next_attempt_at
        : input.now
    let generation = episode.generation
    if (
      episode.status !== "scheduled" ||
      episode.next_attempt_at !== nextAttemptAt
    ) {
      generation += 1
      yield* input.sql.unsafe(
        `UPDATE provider_recovery_episode
         SET status = 'scheduled',
             next_attempt_at = ?,
             generation = ?,
             updated_at = ?
         WHERE work_item_id = ?
           AND status IN ${OPEN_EPISODE}`,
        [nextAttemptAt, generation, input.now, input.workItemId],
      )
    }
    yield* enqueueRecoveryWake({
      queue: input.queue,
      workItemId: input.workItemId,
      generation,
      nextAttemptAt,
      now: input.now,
    })
    return true
  })

export const settleProviderRecoveryCooldown = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly workItemId: string
  readonly now: number
  readonly outcome: "recovered" | "cancelled" | "exited" | "exhausted"
  readonly maxWaitMs: number | null
}) =>
  Effect.gen(function* () {
    const cooldownId = yield* cooldownIdForWorkItem(input.sql, input.workItemId)
    if (cooldownId === null) {
      return
    }
    if (input.outcome === "recovered") {
      const cooldown = yield* loadCooldown(input.sql, cooldownId)
      // Only the probe's success means the scope has recovered. A follower
      // that recovers, for example after an operator Retry, must not release
      // the other waiting items while the probe is still in flight.
      if (cooldown?.probe_work_item_id === input.workItemId) {
        yield* releaseFollowers({
          sql: input.sql,
          queue: input.queue,
          cooldownId,
          now: input.now,
          maxWaitMs: input.maxWaitMs,
        })
        return
      }
      yield* deleteCooldownIfIdle(input.sql, cooldownId)
      return
    }
    const cooldown = yield* loadCooldown(input.sql, cooldownId)
    if (cooldown?.probe_work_item_id === input.workItemId) {
      yield* input.sql.unsafe(
        `UPDATE provider_recovery_cooldown
         SET probe_work_item_id = NULL, probe_claimed_at = NULL, updated_at = ?
         WHERE id = ? AND probe_work_item_id = ?`,
        [input.now, cooldownId, input.workItemId],
      )
    }
    yield* promoteNextProbe({
      sql: input.sql,
      queue: input.queue,
      cooldownId,
      now: input.now,
      excludeWorkItemId: input.workItemId,
      maxWaitMs: input.maxWaitMs,
    })
    yield* deleteCooldownIfIdle(input.sql, cooldownId)
  })

/**
 * Admit at most one probe for a cooling scope. A lost race or a still-valid
 * owner does not take a Worker Slot.
 */
export const gateProviderRecoveryProbe = (input: {
  readonly sql: SqlClient
  readonly workItemId: string
  readonly generation: number
  readonly nextAttemptAt: number
  readonly now: number
}) =>
  Effect.gen(function* () {
    const episode = (yield* input.sql.unsafe(
      `SELECT status, generation, next_attempt_at, cooldown_id
       FROM provider_recovery_episode
       WHERE work_item_id = ?`,
      [input.workItemId],
    )) as readonly {
      readonly status: string
      readonly generation: number
      readonly next_attempt_at: number | null
      readonly cooldown_id: string | null
    }[]
    const current = episode[0]
    if (
      current === undefined ||
      current.cooldown_id === null ||
      current.status !== "scheduled" ||
      current.generation !== input.generation ||
      current.next_attempt_at !== input.nextAttemptAt
    ) {
      return { _tag: "legacy" as const }
    }
    const cooldownId = current.cooldown_id
    yield* clearAbandonedProbe(input.sql, cooldownId, input.now)
    const cooldown = yield* loadCooldown(input.sql, cooldownId)
    if (cooldown === null) {
      return { _tag: "legacy" as const }
    }
    if (
      cooldown.next_attempt_at !== null &&
      cooldown.next_attempt_at > input.now
    ) {
      return { _tag: "not_due" as const }
    }
    const owner = cooldown.probe_work_item_id
    if (
      owner !== null &&
      owner !== input.workItemId &&
      (yield* isValidProbeOwner(input.sql, owner))
    ) {
      return { _tag: "deferred" as const }
    }
    const claimed = (yield* input.sql.unsafe(
      `UPDATE provider_recovery_cooldown
       SET probe_work_item_id = ?,
           probe_claimed_at = ?,
           generation = generation + 1,
           updated_at = ?
       WHERE id = ?
         AND (probe_work_item_id IS NULL OR probe_work_item_id = ?)
       RETURNING id`,
      [input.workItemId, input.now, input.now, cooldown.id, input.workItemId],
    )) as readonly { readonly id: string }[]
    if (claimed[0] === undefined) {
      return { _tag: "deferred" as const }
    }
    return { _tag: "proceed" as const }
  })

/**
 * Explicit Retry becomes the probe when no other turn is already in flight,
 * so the designated automatic probe does not also admit.
 */
export const noteManualRecoveryProbe = (input: {
  readonly sql: SqlClient
  readonly workItemId: string
  readonly now: number
}) =>
  Effect.gen(function* () {
    const cooldownId = yield* cooldownIdForWorkItem(input.sql, input.workItemId)
    if (cooldownId === null) {
      return
    }
    const cooldown = yield* loadCooldown(input.sql, cooldownId)
    const owner = cooldown?.probe_work_item_id
    if (
      owner !== null &&
      owner !== undefined &&
      owner !== input.workItemId &&
      (yield* isValidProbeOwner(input.sql, owner))
    ) {
      const rows = (yield* input.sql.unsafe(
        `SELECT status FROM provider_recovery_episode WHERE work_item_id = ?`,
        [owner],
      )) as readonly { readonly status: string }[]
      if (rows[0]?.status === "in_attempt") {
        return
      }
    }
    yield* input.sql.unsafe(
      `UPDATE provider_recovery_cooldown
       SET probe_work_item_id = ?,
           probe_claimed_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [input.workItemId, input.now, input.now, cooldownId],
    )
  })

/**
 * Restart reconcile must not enqueue a second wake when one is already
 * waiting. The queue service claims jobs; it does not answer "is a wake
 * already pending?" inside this transaction, so this reads the queue table.
 * `job_attempts < job_retry_limit` and an unlocked or expired lease mean the
 * job can still be delivered.
 */
const hasPendingRecoveryJob = (
  sql: SqlClient,
  workItemId: string,
  now: number,
) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT id FROM job_queue
       WHERE queue = ?
         AND job_payload LIKE ?
         AND job_attempts < job_retry_limit
         AND (locked_until IS NULL OR locked_until <= ?)`,
      [WORK_ITEM_LIFECYCLE_QUEUE, `%"${workItemId}"%`, now],
    )) as readonly { readonly id: string }[]
    return rows.length > 0
  })

/**
 * Restart recovery: a probe lease with no queued or running Step Run and no
 * slot wait is abandoned. Re-schedule that owner, or the next eligible item,
 * without extending backoff merely because the process died.
 */
export const reconcileAbandonedProviderRecoveryProbes = (input: {
  readonly sql: SqlClient
  readonly queue: QueueServiceShape
  readonly now: number
  readonly maxWaitMs: number | null
}) =>
  Effect.gen(function* () {
    const cooldowns = (yield* input.sql.unsafe(
      `SELECT id FROM provider_recovery_cooldown`,
    )) as readonly { readonly id: string }[]
    for (const cooldown of cooldowns) {
      const before = yield* loadCooldown(input.sql, cooldown.id)
      const owner = before?.probe_work_item_id
      if (owner !== null && owner !== undefined) {
        const abandoned = !(yield* isValidProbeOwner(input.sql, owner))
        const stuck = (yield* input.sql.unsafe(
          `SELECT e.status AS status
           FROM provider_recovery_episode e
           JOIN work_item w ON w.id = e.work_item_id
           WHERE e.work_item_id = ?
             AND e.status = 'in_attempt'
             AND w.paused = 0
             AND w.waiting_for_blockers = 0
             AND w.waiting_since IS NULL
             AND w.waiting_for_ci_repair = 0
             AND NOT EXISTS (
               SELECT 1 FROM step_run s
               WHERE s.work_item_id = e.work_item_id
                 AND s.status IN ('queued', 'running')
             )`,
          [owner],
        )) as readonly { readonly status: string }[]
        if (stuck[0] !== undefined) {
          const deadline = Math.max(
            input.now,
            before?.next_attempt_at ?? input.now,
          )
          yield* input.sql.unsafe(
            `UPDATE provider_recovery_episode
             SET status = 'scheduled',
                 next_attempt_at = ?,
                 generation = generation + 1,
                 updated_at = ?
             WHERE work_item_id = ?
               AND status = 'in_attempt'`,
            [deadline, input.now, owner],
          )
          const refreshed = (yield* input.sql.unsafe(
            `SELECT generation FROM provider_recovery_episode WHERE work_item_id = ?`,
            [owner],
          )) as readonly { readonly generation: number }[]
          const generation = refreshed[0]?.generation
          if (generation !== undefined) {
            yield* enqueueRecoveryWake({
              queue: input.queue,
              workItemId: owner,
              generation,
              nextAttemptAt: deadline,
              now: input.now,
            })
          }
        } else if (abandoned) {
          yield* clearAbandonedProbe(input.sql, cooldown.id, input.now)
          yield* promoteNextProbe({
            sql: input.sql,
            queue: input.queue,
            cooldownId: cooldown.id,
            now: input.now,
            excludeWorkItemId: owner,
            maxWaitMs: input.maxWaitMs,
          })
        }
      } else {
        yield* promoteNextProbe({
          sql: input.sql,
          queue: input.queue,
          cooldownId: cooldown.id,
          now: input.now,
          excludeWorkItemId: null,
          maxWaitMs: input.maxWaitMs,
        })
      }
      const after = yield* loadCooldown(input.sql, cooldown.id)
      const probe = after?.probe_work_item_id
      if (
        probe !== null &&
        probe !== undefined &&
        after?.next_attempt_at !== null &&
        after.next_attempt_at !== undefined &&
        after.next_attempt_at <= input.now &&
        !(yield* hasPendingRecoveryJob(input.sql, probe, input.now))
      ) {
        const episode = (yield* input.sql.unsafe(
          `SELECT generation, next_attempt_at, status
           FROM provider_recovery_episode
           WHERE work_item_id = ?`,
          [probe],
        )) as readonly {
          readonly generation: number
          readonly next_attempt_at: number | null
          readonly status: string
        }[]
        const row = episode[0]
        if (
          row?.status === "scheduled" &&
          row.next_attempt_at !== null &&
          row.next_attempt_at <= input.now
        ) {
          yield* enqueueRecoveryWake({
            queue: input.queue,
            workItemId: probe,
            generation: row.generation,
            nextAttemptAt: row.next_attempt_at,
            now: input.now,
          })
        }
      }
    }
  })
