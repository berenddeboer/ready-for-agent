import { Effect, Layer, Stream } from "effect"
import {
  DatabaseError,
  DbService,
  type DbServiceShape,
  type IssueRecord,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  type ReadyLabeledIssue,
} from "@ready-for-agent/github-service"
import {
  IssueReconciler,
  IssueReconcilerLive,
  ReconciliationMutationError,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository: RepositoryRecord = {
  id: "repo-1",
  githubOwner: "acme",
  githubRepo: "widgets",
  localPath: "/repos/acme/widgets",
  isBare: true,
  paused: false,
  issuesReconciledAt: null,
}

const remoteIssue = (
  number: number,
  overrides: Partial<ReadyLabeledIssue> = {},
): ReadyLabeledIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  createdAt: new Date(
    `2026-07-${String(number).padStart(2, "0")}T00:00:00.000Z`,
  ),
  state: "OPEN",
  parent: null,
  hasChildren: false,
  hierarchySupported: true,
  blockedBy: [],
  ...overrides,
})

const localIssue = (
  number: number,
  overrides: Partial<IssueRecord> = {},
): IssueRecord => {
  const remote = remoteIssue(number)
  return {
    id: `issue-${number}`,
    repositoryId: repository.id,
    githubIssueNumber: number,
    title: remote.title,
    body: remote.body,
    url: remote.url,
    githubCreatedAt: remote.createdAt,
    state: remote.state,
    hasChildren: remote.hasChildren,
    parent:
      remote.parent === null
        ? null
        : {
            githubIssueNumber: remote.parent.number,
            githubIssueUrl: remote.parent.url,
          },
    blockedBy: remote.blockedBy.map((dependency) => ({
      githubIssueNumber: dependency.number,
      githubIssueUrl: dependency.url,
    })),
    ...overrides,
  }
}

interface DbFixtureOptions {
  readonly issues: readonly IssueRecord[]
  readonly failStoreNumber?: number
  readonly listError?: DatabaseError
  readonly markError?: DatabaseError
}

const makeDbFixture = (options: DbFixtureOptions) => {
  const actions: string[] = []
  const stored: IssueRecord[] = [...options.issues]
  let reconciledAt: Date | undefined

  const service: DbServiceShape = {
    repositoryChanges: Stream.never,
    addRepository: () => Effect.die("not used"),
    listRepositories: Effect.die("not used"),
    listIssues: () => {
      actions.push("list")
      return options.listError
        ? Effect.fail(options.listError)
        : Effect.succeed(stored)
    },
    storeIssue: (input) => {
      actions.push(`store:${input.githubIssueNumber}`)
      if (input.githubIssueNumber === options.failStoreNumber) {
        return Effect.fail(new DatabaseError({ message: "store failed" }))
      }
      const existing = stored.find(
        (issue) => issue.githubIssueNumber === input.githubIssueNumber,
      )
      const record: IssueRecord = {
        id: existing?.id ?? `issue-${input.githubIssueNumber}`,
        ...input,
      }
      if (existing) {
        stored.splice(stored.indexOf(existing), 1, record)
      } else {
        stored.push(record)
      }
      return Effect.succeed(record)
    },
    deleteIssue: (_repositoryId, githubIssueNumber) =>
      Effect.sync(() => {
        actions.push(`delete:${githubIssueNumber}`)
        const index = stored.findIndex(
          (issue) => issue.githubIssueNumber === githubIssueNumber,
        )
        if (index >= 0) stored.splice(index, 1)
      }),
    markIssuesReconciled: (_repositoryId, value) => {
      actions.push("mark")
      return options.markError
        ? Effect.fail(options.markError)
        : Effect.sync(() => {
            reconciledAt = value
          })
    },
  }

  return {
    actions,
    stored,
    get reconciledAt() {
      return reconciledAt
    },
    layer: Layer.succeed(DbService, service),
  }
}

const makeGitHubLayer = (
  issues: readonly ReadyLabeledIssue[],
  actions: string[],
  error?: GitHubRequestError,
) =>
  Layer.succeed(GitHubService, {
    listReadyIssues: ({ owner, name }) => {
      actions.push(`github:${owner}/${name}`)
      return error ? Effect.fail(error) : Effect.succeed(issues)
    },
  } satisfies GitHubServiceShape)

const runReconciliation = <A, E>(
  effect: Effect.Effect<A, E, IssueReconciler>,
  dbLayer: Layer.Layer<DbService>,
  githubLayer: Layer.Layer<GitHubService>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        IssueReconcilerLive.pipe(
          Layer.provide(Layer.merge(dbLayer, githubLayer)),
        ),
      ),
    ),
  )

describe("IssueReconciler", () => {
  it("classifies changes, writes by issue number, and records success", () => {
    const db = makeDbFixture({
      issues: [
        localIssue(1),
        localIssue(2, { title: "Old title" }),
        localIssue(4),
      ],
    })
    const github = makeGitHubLayer(
      [
        remoteIssue(3),
        remoteIssue(2, {
          state: "CLOSED",
          parent: {
            number: 1,
            url: "https://github.com/acme/widgets/issues/1",
            state: "OPEN",
            isReadyLabeled: true,
          },
          blockedBy: [
            {
              number: 1,
              url: "https://github.com/acme/widgets/issues/1",
            },
          ],
        }),
        remoteIssue(1),
      ],
      db.actions,
    )

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary).toEqual({
          fetched: 3,
          inserted: 1,
          updated: 1,
          deleted: 1,
          unchanged: 1,
        })
        expect(db.actions).toEqual([
          "list",
          "github:acme/widgets",
          "store:2",
          "store:3",
          "delete:4",
          "mark",
        ])
        expect(
          db.stored
            .sort(
              (left, right) => left.githubIssueNumber - right.githubIssueNumber,
            )
            .map(({ githubIssueNumber, state }) => ({
              githubIssueNumber,
              state,
            })),
        ).toEqual([
          { githubIssueNumber: 1, state: "OPEN" },
          { githubIssueNumber: 2, state: "CLOSED" },
          { githubIssueNumber: 3, state: "OPEN" },
        ])
        expect(db.reconciledAt).toBeInstanceOf(Date)
        expect(
          db.stored.find((issue) => issue.githubIssueNumber === 2)?.blockedBy,
        ).toEqual([
          {
            githubIssueNumber: 1,
            githubIssueUrl: "https://github.com/acme/widgets/issues/1",
          },
        ])
      }),
      db.layer,
      github,
    )
  })

  it("treats a successful empty result as authoritative", () => {
    const db = makeDbFixture({ issues: [localIssue(2), localIssue(1)] })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary.deleted).toBe(2)
        expect(db.stored).toEqual([])
        expect(db.actions).toEqual([
          "list",
          "github:acme/widgets",
          "delete:1",
          "delete:2",
          "mark",
        ])
      }),
      db.layer,
      makeGitHubLayer([], db.actions),
    )
  })

  it("updates an otherwise unchanged issue when its dependencies change", () => {
    const db = makeDbFixture({ issues: [localIssue(1)] })
    const github = makeGitHubLayer(
      [
        remoteIssue(1, {
          blockedBy: [
            {
              number: 2,
              url: "https://github.com/acme/widgets/issues/2",
            },
          ],
        }),
      ],
      db.actions,
    )

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary.updated).toBe(1)
        expect(db.actions).toEqual([
          "list",
          "github:acme/widgets",
          "store:1",
          "mark",
        ])
      }),
      db.layer,
      github,
    )
  })

  it("updates an otherwise unchanged issue when its parent changes", () => {
    const db = makeDbFixture({ issues: [localIssue(1)] })
    const github = makeGitHubLayer(
      [
        remoteIssue(1, {
          parent: {
            number: 9,
            url: "https://github.com/acme/widgets/issues/9",
            state: "OPEN",
            isReadyLabeled: true,
          },
        }),
      ],
      db.actions,
    )

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary.updated).toBe(1)
        expect(db.stored[0]?.parent).toEqual({
          githubIssueNumber: 9,
          githubIssueUrl: "https://github.com/acme/widgets/issues/9",
        })
      }),
      db.layer,
      github,
    )
  })

  it("updates an otherwise unchanged issue when it gains children", () => {
    const db = makeDbFixture({ issues: [localIssue(1)] })
    const github = makeGitHubLayer(
      [remoteIssue(1, { hasChildren: true })],
      db.actions,
    )

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary.updated).toBe(1)
        expect(db.stored[0]?.hasChildren).toBe(true)
      }),
      db.layer,
      github,
    )
  })

  it("stores only Relevant Issues", () => {
    const db = makeDbFixture({
      issues: [localIssue(3), localIssue(4), localIssue(5), localIssue(6)],
    })
    const parent = {
      number: 1,
      url: "https://github.com/acme/widgets/issues/1",
      state: "OPEN" as const,
      isReadyLabeled: true,
    }
    const github = makeGitHubLayer(
      [
        remoteIssue(1),
        remoteIssue(2, { state: "CLOSED", parent }),
        remoteIssue(3, { state: "CLOSED" }),
        remoteIssue(4, {
          parent: { ...parent, state: "CLOSED" },
        }),
        remoteIssue(5, {
          parent: { ...parent, isReadyLabeled: false },
        }),
        remoteIssue(6, { hierarchySupported: false }),
      ],
      db.actions,
    )

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary).toEqual({
          fetched: 6,
          inserted: 2,
          updated: 0,
          deleted: 4,
          unchanged: 0,
        })
        expect(
          db.stored
            .map((issue) => issue.githubIssueNumber)
            .sort((left, right) => left - right),
        ).toEqual([1, 2])
        expect(
          db.stored.find((issue) => issue.githubIssueNumber === 2)?.state,
        ).toBe("CLOSED")
      }),
      db.layer,
      github,
    )
  })

  it("makes no database changes when the GitHub fetch fails", () => {
    const db = makeDbFixture({ issues: [localIssue(1)] })
    const githubError = new GitHubRequestError({ message: "rate limited" })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const error = yield* Effect.flip(reconciler.reconcile(repository))

        expect(error).toBe(githubError)
        expect(db.actions).toEqual(["list", "github:acme/widgets"])
        expect(db.stored).toHaveLength(1)
        expect(db.reconciledAt).toBeUndefined()
      }),
      db.layer,
      makeGitHubLayer([], db.actions, githubError),
    )
  })

  it("does not spend a GitHub request when the local read fails", () => {
    const databaseError = new DatabaseError({ message: "read failed" })
    const db = makeDbFixture({ issues: [], listError: databaseError })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const error = yield* Effect.flip(reconciler.reconcile(repository))

        expect(error).toBe(databaseError)
        expect(db.actions).toEqual(["list"])
      }),
      db.layer,
      makeGitHubLayer([], db.actions),
    )
  })

  it("reports deterministic partial progress and stops before deletion", () => {
    const db = makeDbFixture({
      issues: [localIssue(2, { title: "Old title" }), localIssue(4)],
      failStoreNumber: 3,
    })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const error = yield* Effect.flip(reconciler.reconcile(repository))

        expect(error).toBeInstanceOf(ReconciliationMutationError)
        if (error instanceof ReconciliationMutationError) {
          expect(error.operation).toBe("insert")
          expect(error.githubIssueNumber).toBe(3)
          expect(error.progress).toEqual({
            fetched: 2,
            inserted: 0,
            updated: 1,
            deleted: 0,
            unchanged: 0,
          })
        }
        expect(db.actions).toEqual([
          "list",
          "github:acme/widgets",
          "store:2",
          "store:3",
        ])
        expect(db.stored.some((issue) => issue.githubIssueNumber === 4)).toBe(
          true,
        )
        expect(db.reconciledAt).toBeUndefined()
      }),
      db.layer,
      makeGitHubLayer([remoteIssue(3), remoteIssue(2)], db.actions),
    )
  })

  it("reports completed mutations when recording success fails", () => {
    const markError = new DatabaseError({ message: "mark failed" })
    const db = makeDbFixture({
      issues: [localIssue(2)],
      markError,
    })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const error = yield* Effect.flip(reconciler.reconcile(repository))

        expect(error).toBeInstanceOf(ReconciliationMutationError)
        if (error instanceof ReconciliationMutationError) {
          expect(error.operation).toBe("record-success")
          expect(error.progress).toEqual({
            fetched: 1,
            inserted: 1,
            updated: 0,
            deleted: 1,
            unchanged: 0,
          })
          expect(error.cause).toBe(markError)
        }
        expect(db.actions).toEqual([
          "list",
          "github:acme/widgets",
          "store:1",
          "delete:2",
          "mark",
        ])
        expect(db.reconciledAt).toBeUndefined()
      }),
      db.layer,
      makeGitHubLayer([remoteIssue(1)], db.actions),
    )
  })
})
