import { Effect, Fiber, Layer, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DatabaseError,
  DbService,
  DbServiceLive,
  InvalidConfigInputError,
  InvalidIssueInputError,
  InvalidRepositoryInputError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
  RepositoryHasRunningStepError,
  RepositoryNotFoundError,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("DbService", () => {
  const TestLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, TestLayer))

  const sampleInput = {
    githubOwner: "acme",
    githubRepo: "widgets",
    localPath: "/repos/acme/widgets.git",
    isBare: true,
  }

  const sampleIssueFields = {
    body: "Issue body",
    url: "https://github.com/acme/widgets/issues/42",
    state: "OPEN" as const,
    parent: null,
    parentPosition: null,
    hasChildren: false,
    blockedBy: [],
  }

  describe("config", () => {
    it("returns defaults and persists updates", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          expect(yield* db.getConfig).toEqual({
            defaultModel: "opencode/deepseek-v4-flash-free",
            defaultVariant: "low",
          })

          expect(
            yield* db.updateConfig({
              defaultModel: "  anthropic/claude-sonnet-4-5  ",
              defaultVariant: "  high  ",
            }),
          ).toEqual({
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
          })
          expect(yield* db.getConfig).toEqual({
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
          })
        }),
      ))

    it("rejects empty values", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const error = yield* Effect.flip(
            db.updateConfig({
              defaultModel: " ",
              defaultVariant: "high",
            }),
          )
          expect(error).toBeInstanceOf(InvalidConfigInputError)
        }),
      ))
  })

  describe("addRepository", () => {
    it("publishes successful membership changes", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const changes = yield* db.repositoryChanges.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          )
          yield* Effect.yieldNow

          const repository = yield* db.addRepository(sampleInput)
          yield* db.removeRepository(repository.id)

          expect(yield* Fiber.join(changes)).toEqual([undefined, undefined])
        }),
      ))

    it("inserts a repository paused with a repo- prefixed id", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repo = yield* db.addRepository(sampleInput)

          expect(repo.id.startsWith("repo-")).toBe(true)
          expect(repo.githubOwner).toBe("acme")
          expect(repo.githubRepo).toBe("widgets")
          expect(repo.localPath).toBe("/repos/acme/widgets.git")
          expect(repo.isBare).toBe(true)
          expect(repo.paused).toBe(true)
          expect(repo.defaultModel).toBeNull()
          expect(repo.defaultVariant).toBeNull()
          expect(repo.autoMerge).toBe(false)
          expect(repo.issuesReconciledAt).toBeNull()
        }),
      ))

    it("trims input fields", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repo = yield* db.addRepository({
            githubOwner: "  acme  ",
            githubRepo: "  widgets  ",
            localPath: "  /repos/acme/widgets.git  ",
            isBare: false,
          })

          expect(repo.githubOwner).toBe("acme")
          expect(repo.githubRepo).toBe("widgets")
          expect(repo.localPath).toBe("/repos/acme/widgets.git")
          expect(repo.isBare).toBe(false)
          expect(repo.paused).toBe(true)
        }),
      ))

    it("rejects empty fields", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const error = yield* Effect.flip(
            db.addRepository({
              ...sampleInput,
              githubOwner: "   ",
            }),
          )

          expect(error).toBeInstanceOf(InvalidRepositoryInputError)
          if (error instanceof InvalidRepositoryInputError) {
            expect(error.field).toBe("githubOwner")
          }
        }),
      ))

    it("fails when github identity already exists (case-insensitive)", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          yield* db.addRepository(sampleInput)

          const error = yield* Effect.flip(
            db.addRepository({
              ...sampleInput,
              githubOwner: "Acme",
              githubRepo: "Widgets",
              localPath: "/other/path",
            }),
          )

          expect(error).toBeInstanceOf(RepositoryAlreadyExistsError)
        }),
      ))

    it("fails when local path is already in use", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          yield* db.addRepository(sampleInput)

          const error = yield* Effect.flip(
            db.addRepository({
              githubOwner: "other",
              githubRepo: "repo",
              localPath: sampleInput.localPath,
              isBare: true,
            }),
          )

          expect(error).toBeInstanceOf(LocalPathInUseError)
        }),
      ))

    it("preserves display casing of owner and repo", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repo = yield* db.addRepository({
            githubOwner: "AcmeCorp",
            githubRepo: "MyWidgets",
            localPath: "/repos/AcmeCorp/MyWidgets",
            isBare: false,
          })

          expect(repo.githubOwner).toBe("AcmeCorp")
          expect(repo.githubRepo).toBe("MyWidgets")
        }),
      ))
  })

  describe("updateRepositorySettings", () => {
    it("updates pause, model override, and auto-merge", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repo = yield* db.addRepository(sampleInput)

          const updated = yield* db.updateRepositorySettings({
            repositoryId: repo.id,
            paused: false,
            defaultModel: "  anthropic/claude-sonnet-4-5  ",
            defaultVariant: "  high  ",
            autoMerge: true,
          })

          expect(updated).toEqual({
            ...repo,
            paused: false,
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
            autoMerge: true,
          })
          expect(yield* db.listRepositories).toEqual([updated])
        }),
      ))

    it("clears model overrides with empty values", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repo = yield* db.addRepository(sampleInput)
          yield* db.updateRepositorySettings({
            repositoryId: repo.id,
            paused: true,
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
            autoMerge: false,
          })

          const cleared = yield* db.updateRepositorySettings({
            repositoryId: repo.id,
            paused: true,
            defaultModel: " ",
            defaultVariant: null,
            autoMerge: false,
          })

          expect(cleared.defaultModel).toBeNull()
          expect(cleared.defaultVariant).toBeNull()
        }),
      ))

    it("rejects unknown repositories", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const error = yield* Effect.flip(
            db.updateRepositorySettings({
              repositoryId: "repo-01J00000000000000000000000",
              paused: false,
              defaultModel: null,
              defaultVariant: null,
              autoMerge: false,
            }),
          )
          expect(error).toBeInstanceOf(RepositoryNotFoundError)
        }),
      ))
  })

  describe("listRepositories", () => {
    it("returns an empty list when none exist", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          expect(yield* db.listRepositories).toEqual([])
        }),
      ))

    it("returns repositories ordered by owner then name", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const zebra = yield* db.addRepository({
            githubOwner: "zebra",
            githubRepo: "tools",
            localPath: "/repos/zebra/tools.git",
            isBare: true,
          })
          const acmeWidgets = yield* db.addRepository(sampleInput)
          const acmeApi = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "api",
            localPath: "/repos/acme/api.git",
            isBare: false,
          })

          expect(yield* db.listRepositories).toEqual([
            acmeApi,
            acmeWidgets,
            zebra,
          ])
        }),
      ))
  })

  describe("removeRepository", () => {
    it("removes the repository, its issues, and issue dependencies", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const sql = yield* SqlClient.SqlClient
          const repository = yield* db.addRepository(sampleInput)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Remove with repository",
            ...sampleIssueFields,
            githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
            blockedBy: [
              {
                githubIssueNumber: 7,
                githubIssueUrl: "https://github.com/acme/widgets/issues/7",
              },
            ],
          })

          yield* db.removeRepository(repository.id)

          expect(yield* db.listRepositories).toEqual([])
          expect(yield* sql.unsafe("SELECT id FROM issue")).toEqual([])
          expect(yield* sql.unsafe("SELECT id FROM issue_dependency")).toEqual(
            [],
          )
        }),
      ))

    it("fails when the repository does not exist", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const error = yield* Effect.flip(db.removeRepository("repo-missing"))

          expect(error).toBeInstanceOf(RepositoryNotFoundError)
        }),
      ))

    it("rejects removal when a Step Run is Running", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const sql = yield* SqlClient.SqlClient
          const repository = yield* db.addRepository(sampleInput)
          const now = Date.now()

          yield* sql.unsafe(
            `INSERT INTO work_item (
               id, repository_id, github_issue_number, model, variant, state,
               state_ready_at, worktree_path, session_id, failure_code,
               failure_message, created_at, updated_at
             ) VALUES (?, ?, 42, 'model', 'low', 'create_worktree', ?, NULL, NULL, NULL, NULL, ?, ?)`,
            ["wi-running-remove-test", repository.id, now, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO step_run (
               id, work_item_id, step, status, queue_job_id, queued_at,
               started_at, finished_at, reason_code, reason_message,
               created_at, updated_at
             ) VALUES (?, ?, 'create_worktree', 'running', 'qjob-1', ?, ?, NULL, NULL, NULL, ?, ?)`,
            [
              "srun-running-remove-test",
              "wi-running-remove-test",
              now,
              now,
              now,
              now,
            ],
          )

          const error = yield* Effect.flip(db.removeRepository(repository.id))
          expect(error).toBeInstanceOf(RepositoryHasRunningStepError)
          expect(yield* db.listRepositories).toHaveLength(1)
          expect(yield* sql.unsafe("SELECT id FROM work_item")).toHaveLength(1)
        }),
      ))

    it("deletes lifecycle history and queued jobs when no Step Run is Running", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const sql = yield* SqlClient.SqlClient
          const repository = yield* db.addRepository(sampleInput)
          const now = Date.now()

          yield* sql.unsafe(
            `INSERT INTO work_item (
               id, repository_id, github_issue_number, model, variant, state,
               state_ready_at, worktree_path, session_id, failure_code,
               failure_message, created_at, updated_at
             ) VALUES (?, ?, 42, 'model', 'low', 'create_worktree', ?, NULL, NULL, NULL, NULL, ?, ?)`,
            ["wi-queued-remove-test", repository.id, now, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO step_run (
               id, work_item_id, step, status, queue_job_id, queued_at,
               started_at, finished_at, reason_code, reason_message,
               created_at, updated_at
             ) VALUES (?, ?, 'create_worktree', 'queued', 'qjob-queued-remove', ?, NULL, NULL, NULL, NULL, ?, ?)`,
            ["srun-queued-remove-test", "wi-queued-remove-test", now, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO job_queue (
               id, queue, job_payload, job_attempts, job_retry_limit,
               available_at, locked_until, created_at, updated_at
             ) VALUES (?, 'jobs', '{}', 0, 1, ?, NULL, ?, ?)`,
            ["qjob-queued-remove", now, now, now],
          )

          yield* db.removeRepository(repository.id)

          expect(yield* db.listRepositories).toEqual([])
          expect(yield* sql.unsafe("SELECT id FROM work_item")).toEqual([])
          expect(yield* sql.unsafe("SELECT id FROM step_run")).toEqual([])
          expect(
            yield* sql.unsafe(
              "SELECT id FROM job_queue WHERE id = 'qjob-queued-remove'",
            ),
          ).toEqual([])
        }),
      ))
  })

  describe("issues", () => {
    const addTestRepository = (db: DbService) => db.addRepository(sampleInput)

    it("stores an issue with an issue-prefixed id", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const githubCreatedAt = new Date("2026-07-01T12:00:00.000Z")
          const issue = yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "  Preserve title spacing  ",
            ...sampleIssueFields,
            githubCreatedAt,
          })

          expect(issue.id.startsWith("issue-")).toBe(true)
          expect(issue.repositoryId).toBe(repository.id)
          expect(issue.githubIssueNumber).toBe(42)
          expect(issue.title).toBe("  Preserve title spacing  ")
          expect(issue.body).toBe("Issue body")
          expect(issue.url).toBe("https://github.com/acme/widgets/issues/42")
          expect(issue.state).toBe("OPEN")
          expect(issue.githubCreatedAt).toEqual(githubCreatedAt)
          expect(issue.parent).toBeNull()
        }),
      ))

    it("updates an existing issue for the same repository and GitHub number", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const first = yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Original title",
            ...sampleIssueFields,
            githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
          })
          const updated = yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Updated title",
            ...sampleIssueFields,
            body: "Updated body",
            state: "CLOSED",
            githubCreatedAt: new Date("2026-07-02T12:00:00.000Z"),
          })

          expect(updated.id).toBe(first.id)
          expect(updated.title).toBe("Updated title")
          expect(updated.body).toBe("Updated body")
          expect(updated.state).toBe("CLOSED")
          expect(updated.githubCreatedAt).toEqual(
            new Date("2026-07-02T12:00:00.000Z"),
          )
          expect(yield* db.listIssues(repository.id)).toHaveLength(1)
        }),
      ))

    it("replaces and lists an issue's blocking dependencies", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const baseInput = {
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Blocked issue",
            ...sampleIssueFields,
            githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
          }
          yield* db.storeIssue({
            ...baseInput,
            blockedBy: [
              {
                githubIssueNumber: 9,
                githubIssueUrl: "https://github.com/other/project/issues/9",
              },
              {
                githubIssueNumber: 3,
                githubIssueUrl: "https://github.com/acme/widgets/issues/3",
              },
            ],
          })

          const stored = yield* db.storeIssue({
            ...baseInput,
            blockedBy: [
              {
                githubIssueNumber: 5,
                githubIssueUrl: "https://github.com/acme/widgets/issues/5",
              },
            ],
          })

          expect(stored.blockedBy).toEqual([
            {
              githubIssueNumber: 5,
              githubIssueUrl: "https://github.com/acme/widgets/issues/5",
            },
          ])
          expect((yield* db.listIssues(repository.id))[0]?.blockedBy).toEqual(
            stored.blockedBy,
          )
        }),
      ))

    it("stores, replaces, and clears an issue's parent", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const baseInput = {
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Child issue",
            ...sampleIssueFields,
            githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
          }

          const withParent = yield* db.storeIssue({
            ...baseInput,
            parentPosition: 4,
            parent: {
              githubIssueNumber: 7,
              githubIssueUrl: "https://github.com/acme/widgets/issues/7",
            },
          })
          expect(withParent.parent).toEqual({
            githubIssueNumber: 7,
            githubIssueUrl: "https://github.com/acme/widgets/issues/7",
          })
          expect(withParent.parentPosition).toBe(4)
          expect((yield* db.listIssues(repository.id))[0]?.parent).toEqual(
            withParent.parent,
          )
          expect((yield* db.listIssues(repository.id))[0]?.parentPosition).toBe(
            4,
          )

          const withoutParent = yield* db.storeIssue({
            ...baseInput,
            parent: null,
          })
          expect(withoutParent.parent).toBeNull()
          expect(withoutParent.parentPosition).toBeNull()
          expect((yield* db.listIssues(repository.id))[0]?.parent).toBeNull()
        }),
      ))

    it("stores and replaces whether an issue has children", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const baseInput = {
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Parent issue",
            ...sampleIssueFields,
            githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
          }

          expect(
            (yield* db.storeIssue({ ...baseInput, hasChildren: true }))
              .hasChildren,
          ).toBe(true)
          expect((yield* db.listIssues(repository.id))[0]?.hasChildren).toBe(
            true,
          )

          expect(
            (yield* db.storeIssue({ ...baseInput, hasChildren: false }))
              .hasChildren,
          ).toBe(false)
        }),
      ))

    it("rolls back the issue and dependencies when replacement fails", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const sql = yield* SqlClient.SqlClient
          const repository = yield* addTestRepository(db)
          const original = yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Original title",
            ...sampleIssueFields,
            githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
            blockedBy: [
              {
                githubIssueNumber: 3,
                githubIssueUrl: "https://github.com/acme/widgets/issues/3",
              },
            ],
          })
          yield* sql.unsafe(`CREATE TRIGGER fail_dependency_insert
            BEFORE INSERT ON issue_dependency
            WHEN NEW.blocking_github_issue_number = 5
            BEGIN
              SELECT RAISE(ABORT, 'forced dependency insert failure');
            END`)

          const error = yield* Effect.flip(
            db.storeIssue({
              repositoryId: repository.id,
              githubIssueNumber: 42,
              title: "Updated title",
              ...sampleIssueFields,
              githubCreatedAt: new Date("2026-07-02T12:00:00.000Z"),
              blockedBy: [
                {
                  githubIssueNumber: 5,
                  githubIssueUrl: "https://github.com/acme/widgets/issues/5",
                },
              ],
            }),
          )

          expect(error).toBeInstanceOf(DatabaseError)
          expect(yield* db.listIssues(repository.id)).toEqual([original])
        }),
      ))

    it("lists only a repository's issues by ascending GitHub number", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const otherRepository = yield* db.addRepository({
            ...sampleInput,
            githubRepo: "other-widgets",
            localPath: "/repos/acme/other-widgets.git",
          })
          const githubCreatedAt = new Date("2026-07-01T12:00:00.000Z")
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 10,
            title: "Tenth",
            ...sampleIssueFields,
            githubCreatedAt,
          })
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 2,
            title: "Second",
            ...sampleIssueFields,
            githubCreatedAt,
          })
          yield* db.storeIssue({
            repositoryId: otherRepository.id,
            githubIssueNumber: 1,
            title: "Other repository",
            ...sampleIssueFields,
            githubCreatedAt,
          })

          const issues = yield* db.listIssues(repository.id)

          expect(issues.map((issue) => issue.githubIssueNumber)).toEqual([
            2, 10,
          ])
        }),
      ))

    it("rejects invalid issue input", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const error = yield* Effect.flip(
            db.storeIssue({
              repositoryId: repository.id,
              githubIssueNumber: 0,
              title: "Valid title",
              ...sampleIssueFields,
              githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
            }),
          )

          expect(error).toBeInstanceOf(InvalidIssueInputError)
          if (error instanceof InvalidIssueInputError) {
            expect(error.field).toBe("githubIssueNumber")
          }
        }),
      ))

    it("rejects a whitespace-only title and invalid creation date", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* addTestRepository(db)
          const titleError = yield* Effect.flip(
            db.storeIssue({
              repositoryId: repository.id,
              githubIssueNumber: 1,
              title: "   ",
              ...sampleIssueFields,
              githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
            }),
          )
          const dateError = yield* Effect.flip(
            db.storeIssue({
              repositoryId: repository.id,
              githubIssueNumber: 1,
              title: "Valid title",
              ...sampleIssueFields,
              githubCreatedAt: new Date("invalid"),
            }),
          )

          expect(titleError).toBeInstanceOf(InvalidIssueInputError)
          expect(dateError).toBeInstanceOf(InvalidIssueInputError)
        }),
      ))

    it("fails for an unknown repository", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const error = yield* Effect.flip(
            db.storeIssue({
              repositoryId: "repo-unknown",
              githubIssueNumber: 1,
              title: "Unknown repository",
              ...sampleIssueFields,
              githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
            }),
          )
          const listError = yield* Effect.flip(db.listIssues("repo-unknown"))

          expect(error).toBeInstanceOf(RepositoryNotFoundError)
          expect(listError).toBeInstanceOf(RepositoryNotFoundError)
        }),
      ))

    it("deletes an issue idempotently and records reconciliation success", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          const sql = yield* SqlClient.SqlClient
          const repository = yield* addTestRepository(db)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            title: "Delete me",
            ...sampleIssueFields,
            githubCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
          })

          yield* db.deleteIssue(repository.id, 42)
          yield* db.deleteIssue(repository.id, 42)
          const reconciledAt = new Date("2026-07-13T08:00:00.000Z")
          yield* db.markIssuesReconciled(repository.id, reconciledAt)

          expect(yield* db.listIssues(repository.id)).toEqual([])
          const rows = yield* sql.unsafe(
            "SELECT issues_reconciled_at FROM repository WHERE id = ?",
            [repository.id],
          )
          expect(rows[0]?.["issues_reconciled_at"]).toBe(reconciledAt.getTime())
        }),
      ))
  })
})
