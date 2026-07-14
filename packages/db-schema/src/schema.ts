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
