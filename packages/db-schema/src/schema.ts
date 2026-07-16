import { sql } from "drizzle-orm"
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { ulid } from "ulidx"

export const repository = snakeCase.table(
  "repository",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => `repo-${ulid()}`),
    githubOwner: text().notNull(),
    githubRepo: text().notNull(),
    localPath: text().notNull().unique(),
    isBare: integer({ mode: "boolean" }).notNull(),
    paused: integer({ mode: "boolean" }).notNull().default(true),
    defaultModel: text(),
    defaultVariant: text(),
    reviewModel: text(),
    reviewVariant: text(),
    autoMerge: integer({ mode: "boolean" }).notNull().default(false),
    issuesReconciledAt: integer({ mode: "number" }),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("repository_github_owner_repo_lower_uidx").on(
      sql`lower(${t.githubOwner})`,
      sql`lower(${t.githubRepo})`,
    ),
  ],
)

export const config = snakeCase.table("config", {
  id: text().primaryKey().default("default"),
  defaultModel: text().notNull().default("opencode/deepseek-v4-flash-free"),
  defaultVariant: text().notNull().default("low"),
  reviewModel: text(),
  reviewVariant: text(),
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
    githubIssueNumber: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    url: text().notNull(),
    state: text({ enum: ["OPEN", "CLOSED"] }).notNull(),
    githubCreatedAt: integer({ mode: "number" }).notNull(),
    parentGithubIssueNumber: integer(),
    parentGithubIssueUrl: text(),
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
    uniqueIndex("issue_repository_id_github_issue_number_uidx").on(
      t.repositoryId,
      t.githubIssueNumber,
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
    blockingGithubIssueNumber: integer().notNull(),
    blockingGithubIssueUrl: text().notNull(),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("issue_dependency_issue_id_blocking_url_uidx").on(
      t.issueId,
      t.blockingGithubIssueUrl,
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
    githubIssueNumber: integer().notNull(),
    githubPullRequestNumber: integer(),
    model: text().notNull(),
    variant: text().notNull(),
    reviewModel: text().notNull(),
    reviewVariant: text().notNull(),
    state: text({
      enum: [
        "create_worktree",
        "install_dependencies",
        "implement",
        "pre_commit",
        "review",
        "commit",
        "create_pr",
        "watch_pr_status_checks",
        "resolve_pr_merge_conflict",
        "investigate_pr_status_checks",
        "mark_pr_ready_for_review",
        "decide_pr_merge",
        "merge_pr",
        "local_cleanup",
        "complete",
        "failed",
        "abandoned",
        "needs_human",
      ],
    }).notNull(),
    stateReadyAt: integer({ mode: "number" }).notNull(),
    worktreePath: text(),
    sessionId: text(),
    failureCode: text(),
    failureMessage: text(),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("work_item_one_unfinished_v2_uidx")
      .on(t.repositoryId, t.githubIssueNumber)
      .where(
        sql`${t.state} NOT IN ('complete', 'failed', 'abandoned', 'needs_human')`,
      ),
    index("work_item_repository_issue_created_idx").on(
      t.repositoryId,
      t.githubIssueNumber,
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
    step: text({
      enum: [
        "create_worktree",
        "install_dependencies",
        "implement",
        "pre_commit",
        "review",
        "commit",
        "create_pr",
        "watch_pr_status_checks",
        "resolve_pr_merge_conflict",
        "investigate_pr_status_checks",
        "mark_pr_ready_for_review",
        "decide_pr_merge",
        "merge_pr",
        "local_cleanup",
      ],
    }).notNull(),
    status: text({
      enum: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "interrupted",
        "cancelled",
      ],
    }).notNull(),
    queueJobId: text(),
    queuedAt: integer({ mode: "number" }).notNull(),
    startedAt: integer({ mode: "number" }),
    finishedAt: integer({ mode: "number" }),
    reasonCode: text(),
    reasonMessage: text(),
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
  ],
)
