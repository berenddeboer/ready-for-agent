import { sql } from "drizzle-orm"
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { ulid } from "ulidx"
import {
  OPERATIONAL_LIFECYCLE_STEPS,
  WORK_ITEM_STATES,
} from "@ready-for-agent/lifecycle-model"

export const repository = snakeCase.table(
  "repository",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `repo-${ulid()}`),
    forge: text({ enum: ["github", "gitlab"] })
      .notNull()
      .default("github"),
    forgeHost: text().notNull().default("github.com"),
    projectPath: text().notNull(),
    localPath: text().notNull().unique(),
    isBare: integer({ mode: "boolean" }).notNull(),
    paused: integer({ mode: "boolean" }).notNull().default(true),
    /**
     * Optional Agent Backend override. Null means inherit harness default.
     * New and migrated rows stay null.
     */
    selectedAgentBackend: text(),
    defaultModel: text(),
    defaultThinkingLevel: text(),
    reviewModel: text(),
    reviewThinkingLevel: text(),
    /**
     * Per-Agent-Backend model preferences (JSON map keyed by backend id).
     * Flat model columns mirror this row's effective backend entry.
     */
    backendModelPrefs: text().notNull().default("{}"),
    /**
     * Three-state Merge Policy. `off` requires a human merge, `classify`
     * runs Decide PR Merge, `always` skips Classify. New Repositories
     * default to `off`.
     */
    mergePolicy: text({ enum: ["off", "classify", "always"] })
      .notNull()
      .default("off"),
    includeAllIssueAuthors: integer({ mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * When true (default), a known draft-to-ready transition starts a Ready-Phase
     * Status Check Round (90s Check-Start Deadline). When false, settled
     * non-failing draft-phase checks may advance to Decide PR Merge without that wait.
     */
    waitForReadyForReviewChecks: integer({ mode: "boolean" })
      .notNull()
      .default(true),
    issuesReconciledAt: integer({ mode: "number" }),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("repository_forge_host_project_path_lower_uidx").on(
      t.forge,
      t.forgeHost,
      sql`lower(${t.projectPath})`,
    ),
  ],
)

export const config = snakeCase.table("config", {
  id: text().primaryKey().default("default"),
  /** Active Agent Backend for the Harness instance (OpenCode by default). */
  selectedAgentBackend: text().notNull().default("opencode"),
  /** Set only after an operator saves the Harness Agent Backend selection. */
  agentBackendConfiguredAt: integer({ mode: "number" }),
  defaultModel: text(),
  defaultThinkingLevel: text(),
  reviewModel: text(),
  reviewThinkingLevel: text(),
  /**
   * Per-Agent-Backend model preferences (JSON map keyed by backend id).
   * Flat model columns mirror the selected backend entry.
   */
  backendModelPrefs: text().notNull().default("{}"),
  maxConcurrentAgentTurns: integer({ mode: "number" }).notNull().default(2),
  maxConcurrentWorkItems: integer({ mode: "number" }).notNull().default(5),
  createdAt: integer({ mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: integer({ mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
})

export const issue = snakeCase.table(
  "issue",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `issue-${ulid()}`),
    repositoryId: text()
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    issueNumber: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    url: text().notNull(),
    state: text({ enum: ["OPEN", "CLOSED"] }).notNull(),
    githubCreatedAt: integer({ mode: "number" }).notNull(),
    issueAuthor: text(),
    parentIssueNumber: integer(),
    parentIssueUrl: text(),
    parentPosition: integer(),
    hasChildren: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("issue_repository_id_issue_number_uidx").on(
      t.repositoryId,
      t.issueNumber,
    ),
  ],
)

export const issueDependency = snakeCase.table(
  "issue_dependency",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `issue-dependency-${ulid()}`),
    issueId: text()
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    blockingIssueNumber: integer().notNull(),
    blockingIssueUrl: text().notNull(),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("issue_dependency_issue_id_blocking_url_uidx").on(
      t.issueId,
      t.blockingIssueUrl,
    ),
  ],
)

/**
 * Background job queue (SQS-style visibility timeout semantics).
 * See xplain: type job queue "qjob"
 */
export const jobQueue = snakeCase.table(
  "job_queue",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `qjob-${ulid()}`),
    queue: text().notNull(),
    /**
     * Stable identity for recurring entries. Null for one-shot jobs.
     * Non-null (queue, key) pairs are unique.
     */
    key: text(),
    jobPayload: text({ mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    jobAttempts: integer({ mode: "number" }).notNull().default(0),
    jobRetryLimit: integer({ mode: "number" }).notNull().default(5),
    availableAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    lockedUntil: integer({ mode: "number" }),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("job_queue_ready_idx").on(
      t.queue,
      t.lockedUntil,
      t.jobAttempts,
      t.availableAt,
    ),
    uniqueIndex("job_queue_queue_key_uidx")
      .on(t.queue, t.key)
      .where(sql`${t.key} IS NOT NULL`),
  ],
)

/**
 * Tracks completed jobs for at-least-once delivery / 2PC with workers.
 * See xplain: type completed job "cj"
 */
export const completedJob = snakeCase.table(
  "completed_job",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `cj-${ulid()}`),
    queue: text().notNull(),
    jobId: text().notNull(),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [uniqueIndex("completed_job_queue_job_id_uidx").on(t.queue, t.jobId)],
)

/**
 * Durable operator-requested implementation attempt for one Issue.
 * See xplain: type work item "wi"
 */
export const workItem = snakeCase.table(
  "work_item",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `wi-${ulid()}`),
    repositoryId: text()
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    issueNumber: integer().notNull(),
    issueTitle: text(),
    pullRequestNumber: integer(),
    /** Active Agent Backend captured at Work Item creation (provenance). */
    agentBackend: text().notNull().default("opencode"),
    /**
     * Whether this Work Item has an Explicit Work Item Execution Profile.
     * Existing and ordinary Work Items stay 0 (settings-resolved models).
     */
    executionProfilePresent: integer({ mode: "boolean" })
      .notNull()
      .default(false),
    executionProfileBuildModel: text(),
    executionProfileBuildThinkingLevel: text(),
    executionProfileReviewSameAsBuild: integer({ mode: "boolean" }),
    executionProfileReviewModel: text(),
    executionProfileReviewThinkingLevel: text(),
    state: text({ enum: WORK_ITEM_STATES }).notNull(),
    stateReadyAt: integer({ mode: "number" }).notNull(),
    paused: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * When set, the Work Item is Waiting for Worker Slot (FIFO by this timestamp).
     * Null when not waiting.
     */
    waitingSince: integer({ mode: "number" }),
    /**
     * Whether this Work Item is Waiting for blockers (Queue hold). Distinct from
     * Waiting for Worker Slot (`waitingSince`) and from Step Run Queued.
     */
    waitingForBlockers: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * Durable merge policy for this Work Item.
     * `ordinary` follows the live Repository Merge Policy and Decide PR Merge.
     * `always` skips Decide PR Merge and advances to Merge PR after checks settle.
     */
    mergeMode: text({ enum: ["ordinary", "always"] })
      .notNull()
      .default("ordinary"),
    /**
     * Work Item Auto-merge override. Null follows the live Repository
     * Merge Policy; true/false is a concrete Classify/Off pin
     * for this Work Item. Distinct from Merge Mode Always.
     */
    autoMergeOverride: integer({ mode: "boolean" }),
    /**
     * Set when an Autonomous Retry was accepted but only entered Waiting for
     * Worker Slot. The next durably created Step Run consumes a budget permit.
     */
    pendingAutonomousRetry: integer({ mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * Whether this Work Item currently occupies a Worker Slot (Admitted).
     */
    holdsWorkerSlot: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * When set, successful advancement into this Lifecycle Step pauses the Work
     * Item (no Step Run enqueued) so the operator can inspect local work.
     */
    pauseBeforeStep: text({ enum: OPERATIONAL_LIFECYCLE_STEPS }),
    worktreePath: text(),
    /**
     * Exact commit OID at Create Worktree success; Assess Changes baseline.
     */
    startingCommitOid: text(),
    /**
     * Durable No-Change Outcome completion summary (Markdown); null until confirmed.
     */
    completionSummary: text(),
    /**
     * Canonical publication title for git commit subject and PR title.
     * Null until Commit generates, seeds, or falls back to harness copy.
     */
    publicationTitle: text(),
    /**
     * Canonical publication body (Markdown) for git commit body and PR body.
     * Includes a normalized `Closes #<issue>` reference. Null until Commit
     * generates, seeds, or falls back to harness copy.
     */
    publicationBody: text(),
    sessionId: text(),
    failureCode: text(),
    failureMessage: text(),
    /**
     * Latest Check-Start Anchor instant (ms since epoch). Null until first
     * Watch observation establishes Last PR Change or a conservative fallback.
     */
    checkStartAnchorAt: integer({ mode: "number" }),
    /**
     * Head SHA the Check-Start Anchor is scoped to. A replacement head must not
     * inherit a prior head's anchor or observation fallback.
     */
    checkStartAnchorHeadSha: text(),
    /**
     * Current head SHA first observed when GitHub omitted a valid push time.
     */
    checkStartObservedHeadSha: text(),
    /**
     * First-observation instant (ms) for checkStartObservedHeadSha.
     */
    checkStartObservedHeadAt: integer({ mode: "number" }),
    /**
     * Last observed Work Item PR draft flag from Watch (1/0). Null until the
     * first boolean draft observation. Used to detect an external draft-to-ready
     * transition that must create a ready-phase Check-Start Anchor.
     */
    checkStartLastObservedIsDraft: integer({ mode: "number" }),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("work_item_one_unfinished_v4_uidx")
      .on(t.repositoryId, t.issueNumber)
      .where(sql`${t.state} NOT IN ('complete', 'failed', 'abandoned')`),
    index("work_item_repository_issue_created_idx").on(
      t.repositoryId,
      t.issueNumber,
      t.createdAt,
    ),
  ],
)

/**
 * One scheduled execution attempt for a Work Item Lifecycle Step.
 * See xplain: type step run "srun"
 */
export const stepRun = snakeCase.table(
  "step_run",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `srun-${ulid()}`),
    workItemId: text()
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    step: text({ enum: OPERATIONAL_LIFECYCLE_STEPS }).notNull(),
    status: text({
      enum: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "interrupted",
        "cancelled",
        "postponed",
      ],
    }).notNull(),
    queueJobId: text(),
    queuedAt: integer({ mode: "number" }).notNull(),
    startedAt: integer({ mode: "number" }),
    finishedAt: integer({ mode: "number" }),
    reasonCode: text(),
    reasonMessage: text(),
    /**
     * Optional JSON diagnostic payload for failed Step Runs (cause chain +
     * machine-readable code). Operator-facing summary stays in reasonMessage.
     */
    reasonDetail: text(),
    /** Present exactly when this finished Step Run was postponed for GitHub. */
    postponedUntil: integer({ mode: "number" }),
    /**
     * Cumulative ms spent blocked on an OpenCode session slot (completed waits).
     * Excluded from max-duration / visibility-lease productive time.
     */
    sessionWaitMs: integer({ mode: "number" }).notNull().default(0),
    /** Wall-clock start of the current OpenCode session-slot wait, if any. */
    sessionWaitStartedAt: integer({ mode: "number" }),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("step_run_one_active_uidx")
      .on(t.workItemId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("step_run_work_item_id_queued_at_idx").on(t.workItemId, t.queuedAt),
  ],
)

/**
 * Observed green or red PR Status Check execution for a Work Item.
 * See xplain: type pr status check "psc"
 */
export const prStatusCheck = snakeCase.table(
  "pr_status_check",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `psc-${ulid()}`),
    workItemId: text()
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    name: text().notNull(),
    outcome: text({ enum: ["green", "red"] }).notNull(),
    handledAt: integer({ mode: "number" }),
    handledByStepRunId: text().references(() => stepRun.id, {
      onDelete: "set null",
    }),
    observedAt: integer({ mode: "number" }).notNull(),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("pr_status_check_work_item_external_uidx").on(
      t.workItemId,
      t.externalId,
    ),
    index("pr_status_check_work_item_handled_idx").on(
      t.workItemId,
      t.handledAt,
    ),
    index("pr_status_check_handled_by_step_run_idx").on(t.handledByStepRunId),
  ],
)

/**
 * Durable Autonomous Retry Budget permits for one Work Item at one
 * Lifecycle Step. The initial Step Run is free; each reserved row is one
 * accepted Autonomous Retry whose Step Run was durably created.
 * See xplain: type autonomous retry "artry"
 */
export const autonomousRetry = snakeCase.table(
  "autonomous_retry",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `artry-${ulid()}`),
    workItemId: text()
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    lifecycleStep: text({ enum: OPERATIONAL_LIFECYCLE_STEPS }).notNull(),
    /**
     * `reserved` counts against the budget once the matching Step Run exists.
     */
    status: text({ enum: ["reserved"] }).notNull(),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("autonomous_retry_budget_idx").on(t.workItemId, t.lifecycleStep),
  ],
)

/**
 * Durable autonomous whole-review workflow rerun permits for a Work Item.
 * Scoped by PR head SHA and workflow run identity; initial execution is free.
 * See xplain: type automated review rerun "arr"
 */
export const automatedReviewRerun = snakeCase.table(
  "automated_review_rerun",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `arr-${ulid()}`),
    workItemId: text()
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    headSha: text().notNull(),
    workflowRunId: text().notNull(),
    workflowName: text(),
    /**
     * Optional incomplete-signature id (ADR 0027 / #971). Null means a general
     * agent-reported RERUN_REVIEW permit. Incomplete and general budgets are
     * counted separately so the one-retry incomplete circuit breaker does not
     * consume the three-rerun agent budget.
     */
    signature: text(),
    /**
     * `reserved` counts against the budget before/without a confirmed GitHub
     * response; `completed` means the harness observed a successful rerun call.
     */
    status: text({ enum: ["reserved", "completed"] }).notNull(),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("automated_review_rerun_budget_idx").on(
      t.workItemId,
      t.headSha,
      t.workflowRunId,
    ),
  ],
)
