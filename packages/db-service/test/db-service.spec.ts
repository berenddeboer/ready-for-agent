import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  InvalidIssueInputError,
  InvalidRepositoryInputError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
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
  }

  describe("addRepository", () => {
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
