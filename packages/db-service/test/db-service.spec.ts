import { Effect, Either, Layer } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  InvalidRepositoryInputError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
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
          const result = yield* Effect.either(
            db.addRepository({
              ...sampleInput,
              githubOwner: "   ",
            }),
          )

          expect(Either.isLeft(result)).toBe(true)
          if (Either.isLeft(result)) {
            expect(result.left).toBeInstanceOf(InvalidRepositoryInputError)
            if (result.left instanceof InvalidRepositoryInputError) {
              expect(result.left.field).toBe("githubOwner")
            }
          }
        }),
      ))

    it("fails when github identity already exists (case-insensitive)", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          yield* db.addRepository(sampleInput)

          const result = yield* Effect.either(
            db.addRepository({
              ...sampleInput,
              githubOwner: "Acme",
              githubRepo: "Widgets",
              localPath: "/other/path",
            }),
          )

          expect(Either.isLeft(result)).toBe(true)
          if (Either.isLeft(result)) {
            expect(result.left).toBeInstanceOf(RepositoryAlreadyExistsError)
          }
        }),
      ))

    it("fails when local path is already in use", () =>
      runTest(
        Effect.gen(function* () {
          const db = yield* DbService
          yield* db.addRepository(sampleInput)

          const result = yield* Effect.either(
            db.addRepository({
              githubOwner: "other",
              githubRepo: "repo",
              localPath: sampleInput.localPath,
              isBare: true,
            }),
          )

          expect(Either.isLeft(result)).toBe(true)
          if (Either.isLeft(result)) {
            expect(result.left).toBeInstanceOf(LocalPathInUseError)
          }
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
})
