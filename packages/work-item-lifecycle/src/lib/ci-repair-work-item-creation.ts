import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { ActiveAgentBackendShape } from "@ready-for-agent/agent-backend"
import {
  type ConfigRecord,
  type DatabaseError,
  RepositoryNotFoundError,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import { defaultIssueTrackerForForge } from "@ready-for-agent/lifecycle-model"
import {
  EnqueueError,
  InvalidQueueNameError,
} from "@ready-for-agent/queue-service"
import { captureEffectiveAgentBackend } from "./capture-effective-agent-backend.js"
import {
  decodeSqlBoolean,
  failurePassesCiRepairBaseline,
  loadCiRepairBaselines,
} from "./ci-repair-baseline.js"
import {
  CI_REPAIR_ISSUE_NATIVE_ID,
  CI_REPAIR_ISSUE_NUMBER,
  type CiRepairFailingRun,
  type CiRepairTarget,
  ciRepairIssueTitle,
  observationQualifiesForAutomaticCiRepair,
  serializeCiRepairFailingRuns,
} from "./ci-repair-work-item.js"
import {
  type AgentBackendUnavailableError,
  type BuildModelNotConfiguredError,
  CiRepairDefaultBranchMissingError,
  CiRepairGateNotClosedError,
  WorkItemLifecycleDatabaseError,
  type WorkItemNotFoundError,
} from "./errors.js"
import type { AgentModelSelection } from "./resolve-agent-models.js"
import type { OperationalLifecycleStep, WorkItemRecord } from "./types.js"
import { makeWorkItemId } from "./types.js"

/**
 * Errors from starting a CI Repair Work Item. Matches the lifecycle service
 * method so callers see the same failure set.
 */
type CiRepairWorkItemStartError =
  | CiRepairGateNotClosedError
  | CiRepairDefaultBranchMissingError
  | BuildModelNotConfiguredError
  | AgentBackendUnavailableError
  | WorkItemLifecycleDatabaseError
  | RepositoryNotFoundError
  | DatabaseError
  | EnqueueError
  | InvalidQueueNameError

export interface CiRepairWorkItemCreationDeps {
  readonly sql: SqlClient.SqlClient
  readonly db: {
    readonly getConfig: Effect.Effect<ConfigRecord, DatabaseError>
    readonly listRepositories: Effect.Effect<
      readonly RepositoryRecord[],
      DatabaseError
    >
    readonly notifyWorkItemsChanged: (
      repositoryId: string,
    ) => Effect.Effect<void>
  }
  readonly activeAgentBackend: Pick<
    ActiveAgentBackendShape,
    | "withConfigCoordination"
    | "getBackendStatus"
    | "requireAgentTurnsAllowed"
    | "getRegistration"
  >
  readonly resolveModelsForBackend: (
    repositoryId: string,
    backendId: string,
  ) => Effect.Effect<
    AgentModelSelection,
    BuildModelNotConfiguredError | DatabaseError
  >
  readonly unfinishedCiRepairWorkItem: (
    repositoryId: string,
  ) => Effect.Effect<WorkItemRecord | null, WorkItemLifecycleDatabaseError>
  readonly getWorkItem: (
    workItemId: string,
  ) => Effect.Effect<
    WorkItemRecord,
    WorkItemNotFoundError | WorkItemLifecycleDatabaseError
  >
  readonly maxWorkerSlots: () => Effect.Effect<
    number,
    WorkItemLifecycleDatabaseError | DatabaseError
  >
  readonly countOccupiedWorkerSlots: () => Effect.Effect<
    number,
    WorkItemLifecycleDatabaseError
  >
  readonly enqueueStepRunForWorkItem: (
    workItemId: string,
    step: OperationalLifecycleStep,
    now: number,
  ) => Effect.Effect<
    void,
    WorkItemLifecycleDatabaseError | EnqueueError | InvalidQueueNameError
  >
  readonly toDatabaseError: (error: SqlError) => WorkItemLifecycleDatabaseError
  readonly isUnfinishedWorkItemUniqueViolation: (error: SqlError) => boolean
}

/**
 * Closed-gate facts shared by manual and automatic start. Automatic
 * qualification is not on this snapshot: manual start does not use it.
 */
interface CiRepairGateSnapshot {
  readonly gateClosed: boolean
  readonly target: CiRepairTarget | null
}

interface CiRepairGateRead {
  readonly snapshot: CiRepairGateSnapshot
  readonly qualifiesForAutomaticStart: boolean
}

const loadCiRepairGate = (
  deps: CiRepairWorkItemCreationDeps,
  repositoryId: string,
): Effect.Effect<CiRepairGateRead, WorkItemLifecycleDatabaseError> =>
  Effect.gen(function* () {
    const branchRows = (yield* deps.sql
      .unsafe(
        `SELECT default_branch
         FROM ci_gate_state
         WHERE repository_id = ?
         LIMIT 1`,
        [repositoryId],
      )
      .pipe(Effect.mapError(deps.toDatabaseError))) as readonly {
      readonly default_branch: string | null
    }[]
    const defaultBranchRaw = branchRows[0]?.default_branch?.trim() ?? ""
    const defaultBranch = defaultBranchRaw === "" ? null : defaultBranchRaw

    const observations = (yield* deps.sql
      .unsafe(
        `SELECT o.definition_identity AS definition_identity,
                o.last_run_identity AS last_run_identity,
                o.last_run_order_key AS last_run_order_key,
                o.last_head_sha AS last_head_sha,
                o.last_raw_status AS last_raw_status,
                o.last_raw_conclusion AS last_raw_conclusion,
                o.failure_latched AS failure_latched,
                o.last_early_job_failure AS last_early_job_failure,
                o.latched_run_identity AS latched_run_identity,
                o.latched_run_order_key AS latched_run_order_key,
                o.latched_run_html_url AS latched_run_html_url,
                d.display_label AS display_label
         FROM ci_gate_definition_observation o
         INNER JOIN ci_gate_definition d
           ON d.repository_id = o.repository_id
          AND d.identity = o.definition_identity
         WHERE o.repository_id = ?
         ORDER BY d.identity ASC`,
        [repositoryId],
      )
      .pipe(Effect.mapError(deps.toDatabaseError))) as readonly {
      readonly definition_identity: string
      readonly last_run_identity: string | null
      readonly last_run_order_key: string | null
      readonly last_head_sha: string | null
      readonly last_raw_status: string | null
      readonly last_raw_conclusion: string | null
      readonly failure_latched: number | boolean | null
      readonly last_early_job_failure: number | boolean | null
      readonly latched_run_identity: string | null
      readonly latched_run_order_key: string | null
      readonly latched_run_html_url: string | null
      readonly display_label: string | null
    }[]

    const baselines = yield* loadCiRepairBaselines(deps.sql, repositoryId).pipe(
      Effect.mapError(deps.toDatabaseError),
    )
    const failingRuns: CiRepairFailingRun[] = []
    const seenRunIdentities = new Set<string>()
    let headSha: string | null = null
    let gateClosed = false
    let qualifiesForAutomaticStart = false
    for (const row of observations) {
      if (!decodeSqlBoolean(row.failure_latched)) {
        continue
      }
      gateClosed = true
      const latchedIdentity = row.latched_run_identity?.trim() ?? ""
      const orderKey = row.latched_run_order_key?.trim() ?? ""
      const definitionIdentity = row.definition_identity?.trim() ?? ""
      if (latchedIdentity !== "" && !seenRunIdentities.has(latchedIdentity)) {
        seenRunIdentities.add(latchedIdentity)
        const htmlUrl = row.latched_run_html_url?.trim() ?? ""
        const label = row.display_label?.trim() ?? ""
        failingRuns.push({
          runIdentity: latchedIdentity,
          htmlUrl: htmlUrl === "" ? null : htmlUrl,
          displayLabel: label === "" ? latchedIdentity : label,
          ...(definitionIdentity === "" ? {} : { definitionIdentity }),
          ...(orderKey === "" ? {} : { orderKey }),
        })
      }
      const lastIdentity = row.last_run_identity?.trim() ?? ""
      if (
        headSha === null &&
        latchedIdentity !== "" &&
        lastIdentity === latchedIdentity
      ) {
        const sha = row.last_head_sha?.trim() ?? ""
        if (sha !== "") {
          headSha = sha
        }
      }
      const qualifiesSignal = observationQualifiesForAutomaticCiRepair({
        failureLatched: true,
        latchedRunIdentity: row.latched_run_identity,
        lastRunIdentity: row.last_run_identity,
        lastRawStatus: row.last_raw_status,
        lastRawConclusion: row.last_raw_conclusion,
        earlyJobFailure: decodeSqlBoolean(row.last_early_job_failure),
      })
      const baseline =
        baselines.find(
          (entry) => entry.definitionIdentity === definitionIdentity,
        ) ?? null
      if (
        qualifiesSignal &&
        latchedIdentity !== "" &&
        failurePassesCiRepairBaseline({
          failure: {
            definitionIdentity,
            runIdentity: latchedIdentity,
            orderKey: orderKey === "" ? null : orderKey,
          },
          baseline,
        })
      ) {
        qualifiesForAutomaticStart = true
      }
    }

    return {
      snapshot: {
        gateClosed,
        target:
          defaultBranch === null
            ? null
            : {
                defaultBranch,
                headSha,
                failingRuns,
              },
      },
      qualifiesForAutomaticStart,
    }
  })

/**
 * Manual start returns the row that won the race. Automatic start loses it
 * and tries again on a later observation. Both policies are live.
 */
const createCiRepairWorkItem = (
  deps: CiRepairWorkItemCreationDeps,
  repositoryId: string,
  evidence: CiRepairTarget,
  onConflict: "return-existing" | "lose",
): Effect.Effect<WorkItemRecord | null, CiRepairWorkItemStartError> =>
  Effect.gen(function* () {
    const createdId = yield* deps.activeAgentBackend.withConfigCoordination(
      Effect.gen(function* () {
        const captured = yield* captureEffectiveAgentBackend({
          repositoryId,
          db: deps.db,
          activeAgentBackend: deps.activeAgentBackend,
          resolveModelsForBackend: deps.resolveModelsForBackend,
          whenRepositoryMissing: "not-found",
        })
        const repository = captured.repository
        if (repository === null) {
          return yield* new RepositoryNotFoundError({ repositoryId })
        }
        const agentBackendId = captured.agentBackendId
        const workItemId = makeWorkItemId()
        const now = yield* Clock.currentTimeMillis
        const step: OperationalLifecycleStep = "create_worktree"
        const issueTracker = defaultIssueTrackerForForge(repository.forge)
        const failingRunsJson = serializeCiRepairFailingRuns(
          evidence.failingRuns,
        )

        return yield* deps.sql
          .withTransaction(
            Effect.gen(function* () {
              const limit = yield* deps.maxWorkerSlots()
              const occupied = yield* deps.countOccupiedWorkerSlots()
              const admit = occupied < limit
              const waitingSince = admit ? null : now
              yield* deps.sql.unsafe(
                `INSERT INTO work_item (
                   id, repository_id, origin,
                   ci_repair_default_branch, ci_repair_head_sha,
                   ci_repair_failing_runs,
                   issue_number, issue_tracker, issue_native_id,
                   issue_display_id, issue_url, agent_backend,
                   issue_title, state, state_ready_at, paused,
                   waiting_since, waiting_for_blockers, waiting_for_ci_repair,
                   merge_mode, holds_worker_slot,
                   pause_before_step, created_at, updated_at
                 ) VALUES (
                   ?, ?, 'ci_repair',
                   ?, ?, ?,
                   ?, ?, ?,
                   ?, '', ?,
                   ?, ?, ?, 0,
                   ?, 0, 0,
                   'ordinary', ?,
                   NULL, ?, ?
                 )`,
                [
                  workItemId,
                  repositoryId,
                  evidence.defaultBranch,
                  evidence.headSha,
                  failingRunsJson,
                  CI_REPAIR_ISSUE_NUMBER,
                  issueTracker,
                  CI_REPAIR_ISSUE_NATIVE_ID,
                  CI_REPAIR_ISSUE_NATIVE_ID,
                  agentBackendId,
                  ciRepairIssueTitle(evidence.defaultBranch),
                  step,
                  now,
                  waitingSince,
                  admit ? 1 : 0,
                  now,
                  now,
                ],
              )
              if (admit) {
                yield* deps.enqueueStepRunForWorkItem(workItemId, step, now)
              }
              return workItemId
            }),
          )
          .pipe(
            Effect.map((id) => ({ _tag: "created" as const, id })),
            Effect.catch(
              (
                error,
              ): Effect.Effect<
                | { readonly _tag: "created"; readonly id: string }
                | { readonly _tag: "conflict" },
                CiRepairWorkItemStartError
              > => {
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "_tag" in error &&
                  (error as { _tag: string })._tag === "SqlError" &&
                  deps.isUnfinishedWorkItemUniqueViolation(error as SqlError)
                ) {
                  return Effect.succeed({ _tag: "conflict" as const })
                }
                if (error instanceof WorkItemLifecycleDatabaseError) {
                  return Effect.fail(error)
                }
                if (error instanceof EnqueueError) {
                  return Effect.fail(error)
                }
                if (error instanceof InvalidQueueNameError) {
                  return Effect.fail(error)
                }
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "_tag" in error &&
                  (error as { _tag: string })._tag === "SqlError"
                ) {
                  return Effect.fail(deps.toDatabaseError(error as SqlError))
                }
                return Effect.fail(
                  new WorkItemLifecycleDatabaseError({
                    message: `Unexpected CI Repair create failure: ${String(error)}`,
                    cause: error,
                  }),
                )
              },
            ),
          )
      }),
    )

    if (createdId._tag === "conflict") {
      if (onConflict === "lose") {
        return null
      }
      const existing = yield* deps.unfinishedCiRepairWorkItem(repositoryId)
      if (existing === null) {
        return yield* new WorkItemLifecycleDatabaseError({
          message: `CI Repair Work Item conflict for ${repositoryId} did not leave an unfinished row`,
        })
      }
      return existing
    }

    const created = yield* deps.getWorkItem(createdId.id).pipe(
      Effect.catchTag(
        "WorkItemNotFoundError",
        (error) =>
          new WorkItemLifecycleDatabaseError({
            message: `CI Repair Work Item missing after create: ${error.workItemId}`,
            cause: error,
          }),
      ),
    )
    yield* deps.db.notifyWorkItemsChanged(created.repositoryId)
    return created
  })

export const startCiRepairWorkItem = (
  deps: CiRepairWorkItemCreationDeps,
  repositoryId: string,
): Effect.Effect<WorkItemRecord, CiRepairWorkItemStartError> =>
  Effect.gen(function* () {
    const existing = yield* deps.unfinishedCiRepairWorkItem(repositoryId)
    if (existing !== null) {
      return existing
    }
    const { snapshot } = yield* loadCiRepairGate(deps, repositoryId)
    if (!snapshot.gateClosed) {
      return yield* new CiRepairGateNotClosedError({
        repositoryId,
        message:
          "Start CI Repair is available only while the CI Gate is Closed",
      })
    }
    if (snapshot.target === null) {
      return yield* new CiRepairDefaultBranchMissingError({
        repositoryId,
        message:
          "Start CI Repair needs the Repository default branch from the CI Gate",
      })
    }
    const created = yield* createCiRepairWorkItem(
      deps,
      repositoryId,
      snapshot.target,
      "return-existing",
    )
    if (created === null) {
      return yield* new WorkItemLifecycleDatabaseError({
        message: `CI Repair Work Item missing after start for ${repositoryId}`,
      })
    }
    return created
  })

export const considerAutomaticCiRepairWorkItem = (
  deps: CiRepairWorkItemCreationDeps,
  repositoryId: string,
): Effect.Effect<WorkItemRecord | null, never> =>
  Effect.gen(function* () {
    const repository = (yield* deps.db.listRepositories).find(
      ({ id }) => id === repositoryId,
    )
    if (
      repository === undefined ||
      !repository.automaticCiRepair ||
      repository.paused
    ) {
      return null
    }
    const existing = yield* deps.unfinishedCiRepairWorkItem(repositoryId)
    if (existing !== null) {
      return null
    }
    const read = yield* loadCiRepairGate(deps, repositoryId)
    if (!read.snapshot.gateClosed || !read.qualifiesForAutomaticStart) {
      return null
    }
    if (read.snapshot.target === null) {
      yield* Effect.logWarning(
        "Automatic CI Repair skipped because the default branch is unknown",
        { repositoryId },
      )
      return null
    }
    return yield* createCiRepairWorkItem(
      deps,
      repositoryId,
      read.snapshot.target,
      "lose",
    )
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Automatic CI Repair did not start", {
        repositoryId,
        error: String(error),
      }).pipe(Effect.as(null)),
    ),
  )
