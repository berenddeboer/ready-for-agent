import { Clock, Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { compareCiGateRunOrder } from "@ready-for-agent/forge-contract"
import type { CiRepairFailingRun } from "./ci-repair-work-item.js"

/**
 * Which CI Repair completion moves the baseline. Abandon and Reset are
 * handled separately: they do not move the baseline.
 */
export type CiRepairBaselineEvent =
  | { readonly _tag: "none" }
  | { readonly _tag: "merged" }
  | { readonly _tag: "no_change" }

export const ciRepairBaselineEvent = (input: {
  readonly origin: string | null | undefined
  readonly step: string
  readonly nextState: string | null
  readonly ownedPrMerged: boolean
}): CiRepairBaselineEvent => {
  if (input.origin !== "ci_repair") {
    return { _tag: "none" }
  }
  if (input.ownedPrMerged) {
    return { _tag: "merged" }
  }
  if (input.step === "merge_pr" && input.nextState === "local_cleanup") {
    return { _tag: "merged" }
  }
  if (
    (input.step === "assess_changes" || input.step === "commit") &&
    input.nextState === "local_cleanup"
  ) {
    return { _tag: "no_change" }
  }
  return { _tag: "none" }
}

export interface CiRepairBaselineRow {
  readonly definitionIdentity: string
  readonly runIdentity: string | null
  readonly orderKey: string | null
  readonly inclusive: boolean
  readonly floorOrderKey: string | null
  readonly suppressThroughRunIdentity: string | null
  readonly suppressThroughOrderKey: string | null
}

export interface CiRepairObservedFailure {
  readonly definitionIdentity: string
  readonly runIdentity: string
  readonly orderKey: string | null
}

const newerThan = (
  candidate: string | null,
  boundary: string | null,
): boolean | null => {
  if (
    candidate === null ||
    candidate === "" ||
    boundary === null ||
    boundary === ""
  ) {
    return null
  }
  return compareCiGateRunOrder(candidate, boundary) > 0
}

const atLeast = (
  candidate: string | null,
  boundary: string | null,
): boolean | null => {
  if (
    candidate === null ||
    candidate === "" ||
    boundary === null ||
    boundary === ""
  ) {
    return null
  }
  return compareCiGateRunOrder(candidate, boundary) >= 0
}

/**
 * A latched failure starts automatic repair only when it is past the
 * baseline. No stored baseline means the first qualifying failure may start.
 * Missing order keys fail closed once a baseline exists, so a restart cannot
 * loop on an uncompared identity.
 */
export const failurePassesCiRepairBaseline = (input: {
  readonly failure: CiRepairObservedFailure
  readonly baseline: CiRepairBaselineRow | null
}): boolean => {
  const baseline = input.baseline
  if (baseline === null) {
    return true
  }
  const failure = input.failure
  if (
    baseline.suppressThroughRunIdentity !== null &&
    baseline.suppressThroughRunIdentity === failure.runIdentity
  ) {
    return false
  }
  if (
    baseline.suppressThroughOrderKey !== null &&
    baseline.suppressThroughOrderKey !== ""
  ) {
    const pastSuppress = newerThan(
      failure.orderKey,
      baseline.suppressThroughOrderKey,
    )
    if (pastSuppress !== true) {
      return false
    }
  }
  if (
    baseline.inclusive &&
    baseline.orderKey !== null &&
    baseline.orderKey !== ""
  ) {
    return atLeast(failure.orderKey, baseline.orderKey) === true
  }
  if (baseline.orderKey !== null && baseline.orderKey !== "") {
    return newerThan(failure.orderKey, baseline.orderKey) === true
  }
  if (baseline.floorOrderKey !== null && baseline.floorOrderKey !== "") {
    return newerThan(failure.orderKey, baseline.floorOrderKey) === true
  }
  // Suppress was already applied. A different run with no order key cannot
  // be proved newer, so it does not auto-start.
  if (
    baseline.suppressThroughRunIdentity !== null &&
    (baseline.suppressThroughOrderKey === null ||
      baseline.suppressThroughOrderKey === "")
  ) {
    return false
  }
  return true
}

const sqlText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const sqlFlag = (value: unknown): boolean =>
  value === true || value === 1 || value === "1"

type SqlRunner = {
  readonly unsafe: (
    statement: string,
    params?: readonly unknown[],
  ) => Effect.Effect<unknown, SqlError>
}

const loadBaselineRows = (sql: SqlRunner, repositoryId: string) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT definition_identity AS definitionIdentity,
              run_identity AS runIdentity,
              order_key AS orderKey,
              inclusive AS inclusive,
              floor_order_key AS floorOrderKey,
              suppress_through_run_identity AS suppressThroughRunIdentity,
              suppress_through_order_key AS suppressThroughOrderKey
       FROM ci_repair_baseline
       WHERE repository_id = ?`,
      [repositoryId],
    )) as readonly {
      readonly definitionIdentity: string
      readonly runIdentity: string | null
      readonly orderKey: string | null
      readonly inclusive: number | boolean | null
      readonly floorOrderKey: string | null
      readonly suppressThroughRunIdentity: string | null
      readonly suppressThroughOrderKey: string | null
    }[]
    return rows.map(
      (row): CiRepairBaselineRow => ({
        definitionIdentity: row.definitionIdentity,
        runIdentity: sqlText(row.runIdentity),
        orderKey: sqlText(row.orderKey),
        inclusive: sqlFlag(row.inclusive),
        floorOrderKey: sqlText(row.floorOrderKey),
        suppressThroughRunIdentity: sqlText(row.suppressThroughRunIdentity),
        suppressThroughOrderKey: sqlText(row.suppressThroughOrderKey),
      }),
    )
  })

export interface CiRepairDefinitionCursor {
  readonly definitionIdentity: string
  readonly lastRunIdentity: string | null
  readonly lastRunOrderKey: string | null
  readonly latchedRunIdentity: string | null
  readonly latchedRunOrderKey: string | null
  readonly failureLatched: boolean
}

const upsertBaseline = (
  sql: SqlRunner,
  input: {
    readonly repositoryId: string
    readonly definitionIdentity: string
    readonly runIdentity: string | null
    readonly orderKey: string | null
    readonly inclusive: boolean
    readonly floorOrderKey: string | null
    readonly suppressThroughRunIdentity: string | null
    readonly suppressThroughOrderKey: string | null
    readonly now: number
  },
) =>
  sql.unsafe(
    `INSERT INTO ci_repair_baseline (
       repository_id, definition_identity, run_identity, order_key,
       head_sha, inclusive, floor_order_key,
       suppress_through_run_identity, suppress_through_order_key, updated_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, definition_identity) DO UPDATE SET
       run_identity = excluded.run_identity,
       order_key = excluded.order_key,
       inclusive = excluded.inclusive,
       floor_order_key = excluded.floor_order_key,
       suppress_through_run_identity = excluded.suppress_through_run_identity,
       suppress_through_order_key = excluded.suppress_through_order_key,
       updated_at = excluded.updated_at`,
    [
      input.repositoryId,
      input.definitionIdentity,
      input.runIdentity,
      input.orderKey,
      input.inclusive ? 1 : 0,
      input.floorOrderKey,
      input.suppressThroughRunIdentity,
      input.suppressThroughOrderKey,
      input.now,
    ],
  )

const loadCursors = (sql: SqlRunner, repositoryId: string) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT definition_identity AS definitionIdentity,
              last_run_identity AS lastRunIdentity,
              last_run_order_key AS lastRunOrderKey,
              latched_run_identity AS latchedRunIdentity,
              latched_run_order_key AS latchedRunOrderKey,
              failure_latched AS failureLatched
       FROM ci_gate_definition_observation
       WHERE repository_id = ?`,
      [repositoryId],
    )) as readonly {
      readonly definitionIdentity: string
      readonly lastRunIdentity: string | null
      readonly lastRunOrderKey: string | null
      readonly latchedRunIdentity: string | null
      readonly latchedRunOrderKey: string | null
      readonly failureLatched: number | boolean | null
    }[]
    return rows.map(
      (row): CiRepairDefinitionCursor => ({
        definitionIdentity: row.definitionIdentity,
        lastRunIdentity: sqlText(row.lastRunIdentity),
        lastRunOrderKey: sqlText(row.lastRunOrderKey),
        latchedRunIdentity: sqlText(row.latchedRunIdentity),
        latchedRunOrderKey: sqlText(row.latchedRunOrderKey),
        failureLatched: sqlFlag(row.failureLatched),
      }),
    )
  })

/** No-Change: the newest observed run is exclusive. A rerun is newer. */
export const recordCiRepairNoChangeBaseline = (
  sql: SqlRunner,
  repositoryId: string,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const cursors = yield* loadCursors(sql, repositoryId)
    for (const cursor of cursors) {
      if (cursor.lastRunIdentity === null) {
        continue
      }
      yield* upsertBaseline(sql, {
        repositoryId,
        definitionIdentity: cursor.definitionIdentity,
        runIdentity: cursor.lastRunIdentity,
        orderKey: cursor.lastRunOrderKey,
        inclusive: false,
        floorOrderKey: null,
        suppressThroughRunIdentity: null,
        suppressThroughOrderKey: null,
        now,
      })
    }
  })

/**
 * Merge: exclusive floor at the failure that started this repair. That run
 * is known to be before the merge, even when the merge is noticed after the
 * merge-commit CI run is already the newest observation. The merge-commit
 * run and any later run are newer, so either failing starts one repair.
 */
export const recordCiRepairMergeFloor = (
  sql: SqlRunner,
  repositoryId: string,
  failingRuns: readonly CiRepairFailingRun[],
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const cursors = yield* loadCursors(sql, repositoryId)
    const seen = new Set<string>()
    for (const run of failingRuns) {
      const located = orderKeyForRun(cursors, run)
      const definitionIdentity =
        run.definitionIdentity ?? located?.definitionIdentity
      // orderKeyForRun uses the triggering run's own order key, or the
      // cursor only when that cursor still names the same run. It does not
      // adopt a newer last run that may already be the merge-commit CI run.
      const floorOrderKey = run.orderKey ?? located?.orderKey ?? null
      if (
        definitionIdentity === undefined ||
        seen.has(definitionIdentity) ||
        floorOrderKey === null
      ) {
        continue
      }
      seen.add(definitionIdentity)
      yield* upsertBaseline(sql, {
        repositoryId,
        definitionIdentity,
        runIdentity: null,
        orderKey: null,
        inclusive: false,
        floorOrderKey,
        suppressThroughRunIdentity: null,
        suppressThroughOrderKey: null,
        now,
      })
    }
  })

const orderKeyForRun = (
  cursors: readonly CiRepairDefinitionCursor[],
  run: CiRepairFailingRun,
): {
  readonly definitionIdentity: string
  readonly orderKey: string | null
} | null => {
  const byIdentity = cursors.find(
    (cursor) =>
      cursor.definitionIdentity === run.definitionIdentity ||
      cursor.latchedRunIdentity === run.runIdentity ||
      cursor.lastRunIdentity === run.runIdentity,
  )
  const definitionIdentity =
    run.definitionIdentity ?? byIdentity?.definitionIdentity
  if (definitionIdentity === undefined) {
    return null
  }
  const orderKey =
    run.orderKey ??
    (byIdentity?.latchedRunIdentity === run.runIdentity
      ? byIdentity.latchedRunOrderKey
      : byIdentity?.lastRunIdentity === run.runIdentity
        ? byIdentity.lastRunOrderKey
        : null)
  return { definitionIdentity, orderKey }
}

/**
 * Abandon or Reset: keep the baseline, but do not restart for the failure
 * that started this Work Item. A newer failure still qualifies.
 */
export const recordCiRepairAbandonSuppress = (
  sql: SqlRunner,
  repositoryId: string,
  failingRuns: readonly CiRepairFailingRun[],
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const cursors = yield* loadCursors(sql, repositoryId)
    const existing = yield* loadBaselineRows(sql, repositoryId)
    for (const run of failingRuns) {
      const located = orderKeyForRun(cursors, run)
      if (located === null) {
        continue
      }
      const prior = existing.find(
        (row) => row.definitionIdentity === located.definitionIdentity,
      )
      yield* sql.unsafe(
        `INSERT INTO ci_repair_baseline (
           repository_id, definition_identity, run_identity, order_key,
           head_sha, inclusive, floor_order_key,
           suppress_through_run_identity, suppress_through_order_key, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(repository_id, definition_identity) DO UPDATE SET
           suppress_through_run_identity = excluded.suppress_through_run_identity,
           suppress_through_order_key = excluded.suppress_through_order_key,
           updated_at = excluded.updated_at`,
        [
          repositoryId,
          located.definitionIdentity,
          prior?.runIdentity ?? null,
          prior?.orderKey ?? null,
          prior?.inclusive === true ? 1 : 0,
          prior?.floorOrderKey ?? null,
          run.runIdentity,
          located.orderKey,
          now,
        ],
      )
    }
  })

export const loadCiRepairBaselines = (sql: SqlRunner, repositoryId: string) =>
  loadBaselineRows(sql, repositoryId)
