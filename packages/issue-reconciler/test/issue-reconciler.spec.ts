import { Effect, Layer } from "effect"
import {
  DatabaseError,
  DbService,
  type IssueRecord,
  type WorkItemPullRequest,
} from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbService,
} from "@ready-for-agent/db-service/test"
import {
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  type ReadyLabeledIssue,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import {
  IssueReconciler,
  IssueReconcilerLive,
  ReconciliationMutationError,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({
  id: "repo-1",
  includeAllIssueAuthors: true,
  waitForReadyForReviewChecks: true,
})

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
  author: null,
  parent: null,
  parentPosition: null,
  hasChildren: false,
  hierarchySupported: true,
  blockedBy: [],
  closingPullRequests: [],
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
    issueNumber: number,
    title: remote.title,
    body: remote.body,
    url: remote.url,
    githubCreatedAt: remote.createdAt,
    state: remote.state,
    issueAuthor: remote.author,
    parentPosition: remote.parentPosition,
    hasChildren: remote.hasChildren,
    parent:
      remote.parent === null
        ? null
        : {
            issueNumber: remote.parent.number,
            issueUrl: remote.parent.url,
          },
    blockedBy: remote.blockedBy.map((dependency) => ({
      issueNumber: dependency.number,
      issueUrl: dependency.url,
    })),
    ...overrides,
  }
}

interface DbFixtureOptions {
  readonly issues: readonly IssueRecord[]
  readonly workItemPullRequests?: readonly WorkItemPullRequest[]
  readonly unfinishedCreatePrWorkItems?: readonly {
    readonly workItemId: string
    readonly issueNumber: number
  }[]
  readonly failStoreNumber?: number
  readonly listError?: DatabaseError
  readonly markError?: DatabaseError
}

const makeDbFixture = (options: DbFixtureOptions) => {
  const actions: string[] = []
  const stored: IssueRecord[] = [...options.issues]
  let reconciledAt: Date | undefined

  const service = stubDbService({
    listIssues: () => {
      actions.push("list")
      return options.listError
        ? Effect.fail(options.listError)
        : Effect.succeed(stored)
    },
    listWorkItemPullRequests: () =>
      Effect.succeed(options.workItemPullRequests ?? []),
    listUnfinishedCreatePrWorkItems: () =>
      Effect.succeed(options.unfinishedCreatePrWorkItems ?? []),
    storeIssue: (input) => {
      actions.push(`store:${input.issueNumber}`)
      if (input.issueNumber === options.failStoreNumber) {
        return Effect.fail(new DatabaseError({ message: "store failed" }))
      }
      const existing = stored.find(
        (issue) => issue.issueNumber === input.issueNumber,
      )
      const record: IssueRecord = {
        id: existing?.id ?? `issue-${input.issueNumber}`,
        ...input,
      }
      if (existing) {
        stored.splice(stored.indexOf(existing), 1, record)
      } else {
        stored.push(record)
      }
      return Effect.succeed(record)
    },
    deleteIssue: (_repositoryId, issueNumber) =>
      Effect.sync(() => {
        actions.push(`delete:${issueNumber}`)
        const index = stored.findIndex(
          (issue) => issue.issueNumber === issueNumber,
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
  })

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
  options: {
    readonly error?: GitHubRequestError
    readonly operatorLogin?: string
    readonly identityError?: GitHubRequestError
  } = {},
) =>
  Layer.succeed(GitHubService, {
    getAuthenticatedUserLogin: ({ projectPath }) => {
      actions.push(`identity:${projectPath}`)
      return options.identityError
        ? Effect.fail(options.identityError)
        : Effect.succeed(options.operatorLogin ?? "operator")
    },
    getOpenPullRequestNumber: () => Effect.succeed(1),
    findOpenPullRequestNumber: () => Effect.succeed(1),
    createDraftPullRequest: () => Effect.succeed(1),
    updateOpenDraftPullRequestCopy: () => Effect.succeed(1),
    countOpenNonDraftPullRequests: () => Effect.succeed(0),
    getPullRequestCheckStatus: () =>
      Effect.succeed({
        _tag: "succeeded",
        terminalChecks: [],
        mergeability: "mergeable",
        baseRefName: "main",
        headPushedAt: null,
        headSha: null,
        createdAt: null,
        isDraft: null,
      }),
    getPrStatusCheckDiagnostics: () => Effect.succeed([]),
    observeAutomatedReviewEvidence: () =>
      Effect.succeed({
        _tag: "ambiguous" as const,
        reason: "Automated review evidence observation is not configured",
      }),
    getPullRequestLifecycleStatus: () =>
      Effect.succeed({ _tag: "open" as const }),
    markPullRequestReadyForReview: () => Effect.void,
    mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
    rerunWorkflowRun: () => Effect.void,
    ensureIssueCompletedWithSummary: () => Effect.void,
    listReadyIssues: ({ projectPath }) => {
      actions.push(`github:${projectPath}`)
      return options.error ? Effect.fail(options.error) : Effect.succeed(issues)
    },
  } satisfies GitHubServiceShape)

const defaultGitLabShape = {
  verifyProject: (repository) => Effect.succeed(repository),
  getAuthenticatedUserLogin: () => Effect.succeed("operator"),
  listReadyIssues: () => Effect.succeed([]),
  hasCredentials: () => Effect.succeed(true),
  hasAmbientCredentials: () => Effect.succeed(true),
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(null),
  createDraftPullRequest: () => Effect.succeed(1),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded",
      terminalChecks: [],
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    }),
  getPrStatusCheckDiagnostics: () => Effect.succeed([]),
  markPullRequestReadyForReview: () => Effect.void,
  getPullRequestLifecycleStatus: () =>
    Effect.succeed({ _tag: "open" as const }),
  mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
  ensureIssueCompletedWithSummary: () => Effect.void,
  closeOpenPullRequestsForBranch: () => Effect.void,
  deleteBranch: () => Effect.void,
} satisfies GitLabServiceShape

const defaultGitLabLayer = Layer.succeed(GitLabService, defaultGitLabShape)

const runReconciliation = <A, E>(
  effect: Effect.Effect<A, E, IssueReconciler>,
  dbLayer: Layer.Layer<DbService>,
  githubLayer: Layer.Layer<GitHubService>,
  gitlabLayer: Layer.Layer<GitLabService> = defaultGitLabLayer,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        IssueReconcilerLive.pipe(
          Layer.provide(Layer.mergeAll(dbLayer, githubLayer, gitlabLayer)),
        ),
      ),
    ),
  )

describe("IssueReconciler", () => {
  it("reconciles GitLab standalone Issues and honors closing-PR ownership", () => {
    const gitlabRepository = makeRepositoryRecord({
      id: "repo-1",
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
      includeAllIssueAuthors: true,
    })
    const db = makeDbFixture({
      issues: [],
      workItemPullRequests: [{ issueNumber: 5, pullRequestNumber: 105 }],
    })
    const issues = [
      remoteIssue(1, {
        hierarchySupported: false,
        blockedBy: [
          {
            number: 99,
            url: "https://git.drupalcode.org/project/oauth_client/-/issues/99",
          },
        ],
      }),
      remoteIssue(2, {
        hierarchySupported: false,
        closingPullRequests: [
          {
            number: 102,
            repository: "project/oauth_client",
            state: "OPEN",
            isDraft: true,
          },
        ],
      }),
      remoteIssue(3, {
        hierarchySupported: false,
        closingPullRequests: [
          {
            number: 103,
            repository: "project/oauth_client",
            state: "MERGED",
            isDraft: false,
          },
        ],
      }),
      remoteIssue(4, {
        hierarchySupported: false,
        closingPullRequests: [
          {
            number: 104,
            repository: "project/oauth_client",
            state: "CLOSED",
            isDraft: false,
          },
        ],
      }),
      remoteIssue(5, {
        hierarchySupported: false,
        closingPullRequests: [
          {
            number: 105,
            repository: "project/oauth_client",
            state: "OPEN",
            isDraft: true,
          },
        ],
      }),
      remoteIssue(6, {
        hierarchySupported: false,
        state: "CLOSED",
        closingPullRequests: [
          {
            number: 106,
            repository: "project/oauth_client",
            state: "MERGED",
            isDraft: false,
          },
        ],
      }),
    ]
    const gitlab = Layer.succeed(GitLabService, {
      ...defaultGitLabShape,
      listReadyIssues: ({ projectPath }) =>
        Effect.sync(() => {
          db.actions.push(`gitlab:${projectPath}`)
          return issues
        }),
    } satisfies GitLabServiceShape)
    const github = makeGitHubLayer([], db.actions)

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(gitlabRepository)

        expect(summary).toEqual({
          fetched: 6,
          inserted: 4,
          updated: 0,
          deleted: 0,
          unchanged: 0,
          competingObservations: [
            {
              issueNumber: 2,
              identities: [{ repository: "project/oauth_client", number: 102 }],
            },
            {
              issueNumber: 6,
              identities: [{ repository: "project/oauth_client", number: 106 }],
            },
          ],
        })
        expect(db.stored.map(({ issueNumber }) => issueNumber)).toEqual([
          1, 3, 4, 5,
        ])
        expect(db.stored[0]?.blockedBy).toEqual([
          {
            issueNumber: 99,
            issueUrl:
              "https://git.drupalcode.org/project/oauth_client/-/issues/99",
          },
        ])
        expect(db.actions).toContain("gitlab:project/oauth_client")
      }),
      db.layer,
      github,
      gitlab,
    )
  })

  it("resolves a scoped GitLab author before fetching remote Issues", () => {
    const gitlabRepository = makeRepositoryRecord({
      id: "repo-1",
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
      includeAllIssueAuthors: false,
    })
    const db = makeDbFixture({ issues: [] })
    const gitlab = Layer.succeed(GitLabService, {
      ...defaultGitLabShape,
      getAuthenticatedUserLogin: ({ projectPath }) =>
        Effect.sync(() => {
          db.actions.push(`gitlab-identity:${projectPath}`)
          return "operator"
        }),
      listReadyIssues: ({ projectPath }) =>
        Effect.sync(() => {
          db.actions.push(`gitlab:${projectPath}`)
          return []
        }),
    } satisfies GitLabServiceShape)

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        yield* reconciler.reconcile(gitlabRepository)

        expect(
          db.actions.indexOf("gitlab-identity:project/oauth_client"),
        ).toBeLessThan(db.actions.indexOf("gitlab:project/oauth_client"))
      }),
      db.layer,
      makeGitHubLayer([], db.actions),
      gitlab,
    )
  })

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
          competingObservations: [],
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
            .sort((left, right) => left.issueNumber - right.issueNumber)
            .map(({ issueNumber, state }) => ({
              issueNumber,
              state,
            })),
        ).toEqual([
          { issueNumber: 1, state: "OPEN" },
          { issueNumber: 2, state: "CLOSED" },
          { issueNumber: 3, state: "OPEN" },
        ])
        expect(db.reconciledAt).toBeInstanceOf(Date)
        expect(
          db.stored.find((issue) => issue.issueNumber === 2)?.blockedBy,
        ).toEqual([
          {
            issueNumber: 1,
            issueUrl: "https://github.com/acme/widgets/issues/1",
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
          parentPosition: 4,
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
          issueNumber: 9,
          issueUrl: "https://github.com/acme/widgets/issues/9",
        })
        expect(db.stored[0]?.parentPosition).toBe(4)
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
          competingObservations: [],
        })
        expect(
          db.stored
            .map((issue) => issue.issueNumber)
            .sort((left, right) => left - right),
        ).toEqual([1, 2])
        expect(db.stored.find((issue) => issue.issueNumber === 2)?.state).toBe(
          "CLOSED",
        )
      }),
      db.layer,
      github,
    )
  })

  it("excludes unmatched ready PRs but ignores draft closing PRs", () => {
    const db = makeDbFixture({
      issues: [
        localIssue(1),
        localIssue(2),
        localIssue(3),
        localIssue(4),
        localIssue(5),
        localIssue(6),
        localIssue(7),
      ],
      workItemPullRequests: [
        { issueNumber: 2, pullRequestNumber: 202 },
        { issueNumber: 3, pullRequestNumber: 303 },
      ],
    })
    const github = makeGitHubLayer(
      [
        remoteIssue(1),
        remoteIssue(2, {
          closingPullRequests: [
            {
              number: 202,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(3, {
          closingPullRequests: [
            {
              number: 300,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
            },
            {
              number: 303,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(4, {
          closingPullRequests: [
            {
              number: 404,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(5, {
          closingPullRequests: [
            {
              number: 202,
              repository: "other/widgets",
              state: "OPEN",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(6, {
          closingPullRequests: [
            {
              number: 606,
              repository: "acme/widgets",
              state: "CLOSED",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(7, {
          closingPullRequests: [
            {
              number: 707,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: true,
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

        expect(summary).toEqual({
          fetched: 7,
          inserted: 0,
          updated: 0,
          deleted: 2,
          unchanged: 5,
          competingObservations: [
            {
              issueNumber: 3,
              identities: [{ repository: "acme/widgets", number: 300 }],
            },
            {
              issueNumber: 4,
              identities: [{ repository: "acme/widgets", number: 404 }],
            },
            {
              issueNumber: 5,
              identities: [{ repository: "other/widgets", number: 202 }],
            },
          ],
        })
        expect(db.stored.map((issue) => issue.issueNumber)).toEqual([
          1, 2, 3, 6, 7,
        ])
      }),
      db.layer,
      github,
    )
  })

  it("restores a reopened Issue whose only closing PR is an unowned merged PR", () => {
    const parent = {
      number: 1014,
      url: "https://github.com/acme/widgets/issues/1014",
      state: "OPEN" as const,
      isReadyLabeled: true,
    }
    const db = makeDbFixture({
      issues: [localIssue(1017), localIssue(1018), localIssue(1019)],
    })
    const github = makeGitHubLayer(
      [
        remoteIssue(1014, {
          closingPullRequests: [
            {
              number: 900,
              repository: "acme/widgets",
              state: "MERGED",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(1015, {
          closingPullRequests: [
            {
              number: 901,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(1016, {
          state: "CLOSED",
          parent,
          closingPullRequests: [
            {
              number: 902,
              repository: "acme/widgets",
              state: "MERGED",
              isDraft: false,
            },
          ],
        }),
        remoteIssue(1017, { parent }),
        remoteIssue(1018, { parent }),
        remoteIssue(1019, { parent }),
      ],
      db.actions,
    )

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary).toEqual({
          fetched: 6,
          inserted: 1,
          updated: 3,
          deleted: 0,
          unchanged: 0,
          competingObservations: [
            {
              issueNumber: 1015,
              identities: [{ repository: "acme/widgets", number: 901 }],
            },
            {
              issueNumber: 1016,
              identities: [{ repository: "acme/widgets", number: 902 }],
            },
          ],
        })
        expect(
          db.stored
            .map((issue) => issue.issueNumber)
            .sort((left, right) => left - right),
        ).toEqual([1014, 1017, 1018, 1019])
        expect(
          db.stored
            .filter((issue) => issue.issueNumber !== 1014)
            .every(
              (issue) =>
                issue.parent?.issueNumber === 1014 &&
                issue.parent.issueUrl === parent.url,
            ),
        ).toBe(true)
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
      makeGitHubLayer([], db.actions, { error: githubError }),
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
          expect(error.issueNumber).toBe(3)
          expect(error.progress).toEqual({
            fetched: 2,
            inserted: 0,
            updated: 1,
            deleted: 0,
            unchanged: 0,
            competingObservations: [],
          })
        }
        expect(db.actions).toEqual([
          "list",
          "github:acme/widgets",
          "store:2",
          "store:3",
        ])
        expect(db.stored.some((issue) => issue.issueNumber === 4)).toBe(true)
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
            competingObservations: [],
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

  it("keeps only operator-authored Issues when Include all is off", () => {
    const scoped = makeRepositoryRecord({
      id: "repo-1",
      includeAllIssueAuthors: false,
      waitForReadyForReviewChecks: true,
    })
    const db = makeDbFixture({
      issues: [
        localIssue(1, { issueAuthor: "operator" }),
        localIssue(2, { issueAuthor: "teammate" }),
      ],
    })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(scoped)

        expect(summary).toEqual({
          fetched: 6,
          inserted: 2,
          updated: 0,
          deleted: 1,
          unchanged: 1,
          competingObservations: [],
        })
        expect(
          db.stored.map((issue) => ({
            number: issue.issueNumber,
            author: issue.issueAuthor,
          })),
        ).toEqual([
          { number: 1, author: "operator" },
          { number: 3, author: "Operator" },
          { number: 5, author: "operator" },
        ])
        expect(db.actions).toContain("identity:acme/widgets")
        expect(db.actions.indexOf("github:acme/widgets")).toBeLessThan(
          db.actions.indexOf("identity:acme/widgets"),
        )
      }),
      db.layer,
      makeGitHubLayer(
        [
          remoteIssue(1, { author: "operator" }),
          remoteIssue(2, { author: "teammate" }),
          remoteIssue(3, { author: "Operator" }),
          remoteIssue(4, { author: null }),
          remoteIssue(5, {
            author: "operator",
            parent: {
              number: 99,
              url: "https://github.com/acme/widgets/issues/99",
              state: "OPEN",
              isReadyLabeled: true,
            },
            parentPosition: 0,
          }),
          remoteIssue(6, {
            author: "teammate",
            parent: {
              number: 1,
              url: "https://github.com/acme/widgets/issues/1",
              state: "OPEN",
              isReadyLabeled: true,
            },
            parentPosition: 0,
          }),
        ],
        db.actions,
        { operatorLogin: "operator" },
      ),
    )
  })

  it("does not filter by author when Include all is on", () => {
    const db = makeDbFixture({ issues: [] })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const summary = yield* reconciler.reconcile(repository)

        expect(summary).toEqual({
          fetched: 2,
          inserted: 2,
          updated: 0,
          deleted: 0,
          unchanged: 0,
          competingObservations: [],
        })
        expect(db.stored.map((issue) => issue.issueNumber).sort()).toEqual([
          1, 2,
        ])
        expect(db.actions).not.toContain("identity:acme/widgets")
      }),
      db.layer,
      makeGitHubLayer(
        [
          remoteIssue(1, { author: "operator" }),
          remoteIssue(2, { author: "teammate" }),
        ],
        db.actions,
      ),
    )
  })

  it("stores Issue Author from the Ready-labeled fetch", () => {
    const db = makeDbFixture({ issues: [] })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        yield* reconciler.reconcile(repository)
        expect(db.stored[0]?.issueAuthor).toBe("octocat")
      }),
      db.layer,
      makeGitHubLayer([remoteIssue(1, { author: "octocat" })], db.actions),
    )
  })

  it("fails without mutating the store when identity cannot be resolved", () => {
    const scoped = makeRepositoryRecord({
      id: "repo-1",
      includeAllIssueAuthors: false,
      waitForReadyForReviewChecks: true,
    })
    const db = makeDbFixture({ issues: [localIssue(1, { issueAuthor: "op" })] })
    const identityError = new GitHubRequestError({
      message: "Failed to resolve authenticated GitHub user",
    })

    return runReconciliation(
      Effect.gen(function* () {
        const reconciler = yield* IssueReconciler
        const error = yield* Effect.flip(reconciler.reconcile(scoped))

        expect(error).toBe(identityError)
        expect(db.actions).toEqual([
          "list",
          "github:acme/widgets",
          "identity:acme/widgets",
        ])
        expect(db.stored).toHaveLength(1)
        expect(db.reconciledAt).toBeUndefined()
      }),
      db.layer,
      makeGitHubLayer([remoteIssue(1, { author: "op" })], db.actions, {
        identityError,
        operatorLogin: "op",
      }),
    )
  })

  it("treats a Create PR branch match as pending self-ownership, not competition", () => {
    const db = makeDbFixture({
      issues: [localIssue(1)],
      unfinishedCreatePrWorkItems: [
        { workItemId: "wi-create", issueNumber: 1 },
      ],
    })
    const github = makeGitHubLayer(
      [
        remoteIssue(1, {
          closingPullRequests: [
            {
              number: 501,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
              sourceBranch: "rfa/acme-widgets/1/wi-create",
              sourceRepository: "acme/widgets",
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

        expect(summary.deleted).toBe(0)
        expect(summary.competingObservations).toEqual([])
        expect(db.stored.map((issue) => issue.issueNumber)).toEqual([1])
      }),
      db.layer,
      github,
    )
  })

  it("still reports a fork with the same branch as competing during Create PR", () => {
    const db = makeDbFixture({
      issues: [localIssue(1)],
      unfinishedCreatePrWorkItems: [
        { workItemId: "wi-create", issueNumber: 1 },
      ],
    })
    const github = makeGitHubLayer(
      [
        remoteIssue(1, {
          closingPullRequests: [
            {
              number: 501,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
              sourceBranch: "rfa/acme-widgets/1/wi-create",
              sourceRepository: "acme/widgets",
            },
            {
              number: 502,
              repository: "acme/widgets",
              state: "OPEN",
              isDraft: false,
              sourceBranch: "rfa/acme-widgets/1/wi-create",
              sourceRepository: "alice/widgets",
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

        expect(summary.competingObservations).toEqual([
          {
            issueNumber: 1,
            identities: [{ repository: "acme/widgets", number: 502 }],
          },
        ])
        expect(db.stored.map((issue) => issue.issueNumber)).toEqual([1])
      }),
      db.layer,
      github,
    )
  })
})
