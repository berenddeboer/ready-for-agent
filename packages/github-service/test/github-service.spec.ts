import { Effect, Result } from "effect"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type ReadyLabeledIssue,
  makeGitHubServiceTest,
} from "../src/index.js"
import {
  type GitHubGraphqlClient,
  makeGitHubService,
} from "../src/lib/github-service-live.js"
import { describe, expect, it } from "bun:test"

const repository = { owner: "acme", name: "widgets" }

const issue = (
  number: number,
  state: "OPEN" | "CLOSED" = "OPEN",
): ReadyLabeledIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  createdAt: new Date(`2026-07-${String(number).padStart(2, "0")}T12:00:00Z`),
  state,
  parent: null,
  parentPosition: null,
  hasChildren: false,
  hierarchySupported: true,
  blockedBy: [],
})

describe("GitHubService live implementation", () => {
  for (const [state, expected] of [
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    ["SUCCESS", "succeeded"],
    ["FAILURE", "failed"],
    ["ERROR", "failed"],
  ] as const) {
    it(`maps aggregate PR check state ${state} to ${expected}`, async () => {
      const service = makeGitHubService({
        query: () =>
          Promise.resolve({
            repository: {
              pullRequests: {
                nodes: [
                  {
                    state: "OPEN",
                    merged: false,
                    statusCheckRollup: { state },
                  },
                ],
              },
            },
          }) as never,
      })

      const status = await Effect.runPromise(
        service.getPullRequestCheckStatus(
          repository,
          "rfa/acme-widgets/42/wi-1",
        ),
      )

      expect(status).toEqual({ _tag: expected })
    })
  }

  it("treats a not-yet-visible PR as pending and a PR without checks as no_checks", async () => {
    const responses = [
      { repository: { pullRequests: { nodes: [] } } },
      {
        repository: {
          pullRequests: {
            nodes: [{ state: "OPEN", merged: false, statusCheckRollup: null }],
          },
        },
      },
    ]
    const service = makeGitHubService({
      query: () => Promise.resolve(responses.shift()!) as never,
    })

    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "pending" })
    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "no_checks" })
  })

  it("distinguishes closed and merged PRs from a not-yet-visible PR", async () => {
    const responses = [
      {
        repository: {
          pullRequests: {
            nodes: [
              { state: "CLOSED", merged: false, statusCheckRollup: null },
            ],
          },
        },
      },
      {
        repository: {
          pullRequests: {
            nodes: [{ state: "CLOSED", merged: true, statusCheckRollup: null }],
          },
        },
      },
    ]
    const service = makeGitHubService({
      query: () => Promise.resolve(responses.shift()!) as never,
    })

    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "closed" })
    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "succeeded" })
  })

  it("marks a draft PR ready for review and no-ops when already ready", async () => {
    const mutations: unknown[] = []
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDODraft",
                  isDraft: true,
                  state: "OPEN",
                },
              ],
            },
          },
        }) as never,
      mutation: (request) => {
        mutations.push(request)
        return Promise.resolve({
          markPullRequestReadyForReview: {
            pullRequest: { isDraft: false },
          },
        }) as never
      },
    })

    await Effect.runPromise(
      service.markPullRequestReadyForReview(repository, "branch"),
    )
    expect(mutations).toHaveLength(1)

    const alreadyReady = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOReady",
                  isDraft: false,
                  state: "OPEN",
                },
              ],
            },
          },
        }) as never,
      mutation: () => {
        throw new Error("mutation should not run for a non-draft PR")
      },
    })

    await Effect.runPromise(
      alreadyReady.markPullRequestReadyForReview(repository, "branch"),
    )
  })

  it("fails when the PR for the branch is missing", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: { pullRequests: { nodes: [] } },
        }) as never,
    })

    const exit = await Effect.runPromise(
      Effect.result(
        service.markPullRequestReadyForReview(repository, "branch"),
      ),
    )
    expect(Result.isFailure(exit)).toBe(true)
    if (Result.isFailure(exit)) {
      expect(exit.failure).toBeInstanceOf(GitHubRequestError)
    }
  })

  it("fails when the PR was closed after its checks passed", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOClosed",
                  isDraft: false,
                  state: "CLOSED",
                },
              ],
            },
          },
        }) as never,
    })

    const result = await Effect.runPromise(
      Effect.result(
        service.markPullRequestReadyForReview(repository, "branch"),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRequestError)
    }
  })

  it("fetches every ready-for-agent page and returns mapped issues by number", async () => {
    const requests: unknown[] = []
    const responses = [
      {
        repository: {
          issues: {
            nodes: [
              {
                number: 9,
                title: "Later issue",
                body: "Later body",
                url: "https://github.com/acme/widgets/issues/9",
                createdAt: "2026-07-09T12:00:00Z",
                state: "OPEN",
                parent: {
                  number: 1,
                  url: "https://github.com/acme/widgets/issues/1",
                  state: "OPEN",
                  repository: { nameWithOwner: "acme/widgets" },
                  parent: null,
                },
                subIssuesSummary: { total: 0 },
                subIssues: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                blockedBy: {
                  nodes: [
                    {
                      number: 3,
                      url: "https://github.com/acme/widgets/issues/3",
                      state: "OPEN",
                    },
                    {
                      number: 4,
                      url: "https://github.com/acme/widgets/issues/4",
                      state: "CLOSED",
                    },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            ],
            pageInfo: { endCursor: "page-2", hasNextPage: true },
          },
        },
      },
      {
        repository: {
          issues: {
            nodes: [
              null,
              {
                number: 2,
                title: "Earlier issue",
                body: "Earlier body",
                url: "https://github.com/acme/widgets/issues/2",
                createdAt: "2026-07-02T12:00:00Z",
                state: "CLOSED",
                parent: null,
                subIssuesSummary: { total: 0 },
                subIssues: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                blockedBy: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    ]
    const client = {
      query: async (request: unknown) => {
        requests.push(request)
        return responses.shift()
      },
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository),
    )

    expect(result.map(({ number }) => number)).toEqual([2, 9])
    expect(result[0]).toEqual({
      number: 2,
      title: "Earlier issue",
      body: "Earlier body",
      url: "https://github.com/acme/widgets/issues/2",
      createdAt: new Date("2026-07-02T12:00:00Z"),
      state: "CLOSED",
      parent: null,
      parentPosition: null,
      hasChildren: false,
      hierarchySupported: true,
      blockedBy: [],
    })
    expect(result[1]?.parent).toEqual({
      number: 1,
      url: "https://github.com/acme/widgets/issues/1",
      state: "OPEN",
      isReadyLabeled: false,
    })
    expect(result[1]?.blockedBy).toEqual([
      {
        number: 3,
        url: "https://github.com/acme/widgets/issues/3",
      },
    ])
    expect(requests).toHaveLength(2)

    const firstRequest = requests[0] as {
      repository: {
        __args: { owner: string; name: string }
        issues: {
          __args: { first: number; after: string | null; labels: string[] }
          nodes: Record<string, boolean>
        }
      }
    }
    expect(firstRequest.repository.__args).toEqual(repository)
    expect(firstRequest.repository.issues.__args).toEqual({
      first: 100,
      after: null,
      labels: ["ready-for-agent"],
    })
    expect(firstRequest.repository.issues.nodes).toEqual({
      number: true,
      title: true,
      body: true,
      url: true,
      createdAt: true,
      state: true,
      parent: {
        number: true,
        url: true,
        state: true,
        repository: { nameWithOwner: true },
        parent: {
          number: true,
          url: true,
          repository: { nameWithOwner: true },
        },
      },
      subIssuesSummary: { total: true },
      subIssues: {
        __args: { first: 100 },
        nodes: {
          number: true,
          url: true,
          repository: { nameWithOwner: true },
          subIssuesSummary: { total: true },
        },
        pageInfo: { endCursor: true, hasNextPage: true },
      },
      blockedBy: {
        __args: { first: 100 },
        nodes: { number: true, url: true, state: true },
        pageInfo: { endCursor: true, hasNextPage: true },
      },
    })

    const secondRequest = requests[1] as typeof firstRequest
    expect(secondRequest.repository.issues.__args.after).toBe("page-2")
  })

  it("fetches additional dependency pages only when needed", async () => {
    const requests: unknown[] = []
    const responses = [
      {
        repository: {
          issues: {
            nodes: [
              {
                number: 7,
                title: "Blocked issue",
                body: "Body",
                url: "https://github.com/acme/widgets/issues/7",
                createdAt: "2026-07-07T12:00:00Z",
                state: "OPEN",
                parent: null,
                subIssuesSummary: { total: 0 },
                subIssues: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                blockedBy: {
                  nodes: [
                    {
                      number: 5,
                      url: "https://github.com/acme/widgets/issues/5",
                      state: "OPEN",
                    },
                  ],
                  pageInfo: {
                    endCursor: "dependency-page-2",
                    hasNextPage: true,
                  },
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
      {
        repository: {
          issue: {
            blockedBy: {
              nodes: [
                {
                  number: 2,
                  url: "https://github.com/acme/widgets/issues/2",
                  state: "OPEN",
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    ]
    const client = {
      query: async (request: unknown) => {
        requests.push(request)
        return responses.shift()
      },
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository),
    )

    expect(result[0]?.blockedBy.map(({ number }) => number)).toEqual([2, 5])
    expect(requests).toHaveLength(2)
    const dependencyRequest = requests[1] as {
      repository: {
        issue: {
          __args: { number: number }
          blockedBy: { __args: { first: number; after: string } }
        }
      }
    }
    expect(dependencyRequest.repository.issue.__args).toEqual({ number: 7 })
    expect(dependencyRequest.repository.issue.blockedBy.__args).toEqual({
      first: 100,
      after: "dependency-page-2",
    })
  })

  it("marks an entire hierarchy unsupported when an unlabeled child has a child", async () => {
    const child = {
      number: 2,
      title: "Direct child",
      body: "Body",
      url: "https://github.com/acme/widgets/issues/2",
      createdAt: "2026-07-02T12:00:00Z",
      state: "OPEN",
      parent: {
        number: 1,
        url: "https://github.com/acme/widgets/issues/1",
        state: "OPEN",
        repository: { nameWithOwner: "acme/widgets" },
        parent: null,
      },
      subIssuesSummary: { total: 0 },
      subIssues: {
        nodes: [],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
      blockedBy: {
        nodes: [],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }
    const client = {
      query: async () => ({
        repository: {
          issues: {
            nodes: [
              {
                number: 1,
                title: "Root",
                body: "Body",
                url: "https://github.com/acme/widgets/issues/1",
                createdAt: "2026-07-01T12:00:00Z",
                state: "OPEN",
                parent: null,
                subIssuesSummary: { total: 1 },
                subIssues: {
                  nodes: [
                    {
                      number: 2,
                      url: "https://github.com/acme/widgets/issues/2",
                      repository: { nameWithOwner: "acme/widgets" },
                      subIssuesSummary: { total: 1 },
                    },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                blockedBy: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
              child,
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      }),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository),
    )

    expect(result.map(({ hierarchySupported }) => hierarchySupported)).toEqual([
      false,
      false,
    ])
    expect(result.map(({ hasChildren }) => hasChildren)).toEqual([true, false])
    expect(result[1]?.parent?.isReadyLabeled).toBe(true)
    expect(result[1]?.parentPosition).toBe(0)
  })

  it("checks every sub-issue page for cross-Repository relationships", async () => {
    const requests: unknown[] = []
    const responses = [
      {
        repository: {
          issues: {
            nodes: [
              {
                number: 1,
                title: "Root",
                body: "Body",
                url: "https://github.com/acme/widgets/issues/1",
                createdAt: "2026-07-01T12:00:00Z",
                state: "OPEN",
                parent: null,
                subIssuesSummary: { total: 1 },
                subIssues: {
                  nodes: [],
                  pageInfo: {
                    endCursor: "sub-issue-page-2",
                    hasNextPage: true,
                  },
                },
                blockedBy: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
      {
        repository: {
          issue: {
            subIssues: {
              nodes: [
                {
                  number: 2,
                  url: "https://github.com/acme/other/issues/2",
                  repository: { nameWithOwner: "acme/other" },
                  subIssuesSummary: { total: 0 },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    ]
    const client = {
      query: async (request: unknown) => {
        requests.push(request)
        return responses.shift()
      },
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository),
    )

    expect(result[0]?.hierarchySupported).toBe(false)
    const continuation = requests[1] as {
      repository: {
        issue: {
          subIssues: { __args: { first: number; after: string } }
        }
      }
    }
    expect(continuation.repository.issue.subIssues.__args).toEqual({
      first: 100,
      after: "sub-issue-page-2",
    })
  })

  it("fails when the Repository is missing or inaccessible", async () => {
    const client = {
      query: async () => ({ repository: null }),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.result),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toEqual(
        new GitHubRepositoryUnavailableError(repository),
      )
    }
  })

  it("wraps GenQL failures as request errors", async () => {
    const cause = new Error("Bad credentials")
    const client = {
      query: async () => Promise.reject(cause),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.result),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRequestError)
      expect(result.failure.cause).toBe(cause)
    }
  })

  it("rejects malformed Issue data before returning a partial result", async () => {
    const client = {
      query: async () => ({
        repository: {
          issues: {
            nodes: [
              {
                number: 1,
                title: "Valid title",
                body: "Valid body",
                url: "not-a-url",
                createdAt: "2026-07-01T12:00:00Z",
                state: "OPEN",
                parent: null,
                subIssuesSummary: { total: 0 },
                subIssues: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                blockedBy: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      }),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.result),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRequestError)
      expect(result.failure.message).toContain("invalid Issue data")
    }
  })

  it("wraps malformed sub-issue positions as request errors", async () => {
    const client = {
      query: async () => ({
        repository: {
          issues: {
            nodes: [
              {
                number: 1,
                title: "Root",
                body: "Body",
                url: "https://github.com/acme/widgets/issues/1",
                createdAt: "2026-07-01T12:00:00Z",
                state: "OPEN",
                parent: null,
                subIssuesSummary: { total: 2 },
                subIssues: {
                  nodes: [
                    {
                      number: 2,
                      url: "https://github.com/acme/other/issues/2",
                      repository: { nameWithOwner: "acme/other" },
                      subIssuesSummary: { total: 0 },
                    },
                    {
                      number: "invalid",
                      url: "https://github.com/acme/widgets/issues/3",
                      repository: { nameWithOwner: "acme/widgets" },
                      subIssuesSummary: { total: 0 },
                    },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                blockedBy: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      }),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.result),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRequestError)
      expect(result.failure.message).toContain("invalid sub-issue data")
    }
  })

  it("fails when GitHub reports another page without a cursor", async () => {
    const client = {
      query: async () => ({
        repository: {
          issues: {
            nodes: [],
            pageInfo: { endCursor: null, hasNextPage: true },
          },
        },
      }),
    } as GitHubGraphqlClient

    const result = await Effect.runPromise(
      makeGitHubService(client).listReadyIssues(repository).pipe(Effect.result),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRequestError)
      expect(result.failure.message).toContain("omitted the next page cursor")
    }
  })
})

describe("makeGitHubServiceTest", () => {
  it("looks up Repository fixtures case-insensitively and sorts their issues", async () => {
    const layer = makeGitHubServiceTest([
      { repository, issues: [issue(9), issue(2, "CLOSED")] },
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.listReadyIssues({ owner: "ACME", name: "Widgets" })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.map(({ number }) => number)).toEqual([2, 9])
  })

  it("returns a configured request failure", async () => {
    const error = new GitHubRequestError({ message: "Rate limited" })
    const layer = makeGitHubServiceTest([{ repository, error }])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.listReadyIssues(repository)
      }).pipe(Effect.provide(layer), Effect.result),
    )

    expect(result).toEqual(Result.fail(error))
  })

  it("fails unavailable for a Repository without a fixture", async () => {
    const layer = makeGitHubServiceTest([])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.listReadyIssues(repository)
      }).pipe(Effect.provide(layer), Effect.result),
    )

    expect(result).toEqual(
      Result.fail(new GitHubRepositoryUnavailableError(repository)),
    )
  })
})
