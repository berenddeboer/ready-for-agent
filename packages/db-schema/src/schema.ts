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
      .$defaultFn(() => ulid()),
    githubOwner: text().notNull(),
    githubRepo: text().notNull(),
    localPath: text().notNull().unique(),
    isBare: integer({ mode: "boolean" }).notNull(),
    paused: integer({ mode: "boolean" }).notNull().default(true),
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
