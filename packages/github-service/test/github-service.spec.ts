import { spawnSync } from "node:child_process"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import { decodeArgument } from "../src/bin/cli.js"
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
  closingPullRequests: [],
})

describe("GitHubService live implementation", () => {
  it.effect("aborts an in-flight request when interrupted", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined
      const service = makeGitHubService({
        query: (_request, signal) => {
          requestSignal = signal
          return new Promise(() => undefined)
        },
      })

      const fiber = yield* service
        .getOpenPullRequestNumber(repository, "branch")
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)

      expect(requestSignal?.aborted).toBe(true)
    }),
  )

  it.effect("aborts and maps a request timeout to GitHubRequestError", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined
      const service = makeGitHubService({
        query: (_request, signal) => {
          requestSignal = signal
          return new Promise(() => undefined)
        },
      })

      const fiber = yield* service
        .getOpenPullRequestNumber(repository, "branch")
        .pipe(Effect.result, Effect.forkChild)
      yield* Effect.yieldNow
      // Three attempts (initial + 2 retries), each with a 30s timeout and 500ms delay.
      yield* TestClock.adjust("92 seconds")
      const result = yield* Fiber.join(fiber)

      expect(requestSignal?.aborted).toBe(true)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(GitHubRequestError)
        expect(result.failure.message).toContain("timed out")
      }
    }),
  )

  it("resolves the open pull request number for a branch", async () => {
    let request: unknown
    const service = makeGitHubService({
      query: (input) => {
        request = input
        return Promise.resolve({
          repository: { pullRequests: { nodes: [{ number: 321 }] } },
        }) as never
      },
    })

    expect(
      await Effect.runPromise(
        service.getOpenPullRequestNumber(repository, "rfa/issue-42"),
      ),
    ).toBe(321)
    expect(request).toEqual({
      repository: {
        __args: repository,
        pullRequests: {
          __args: {
            first: 1,
            states: ["OPEN"],
            headRefName: "rfa/issue-42",
          },
          nodes: { number: true },
        },
      },
    })
  })

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
                    headRefOid: "abc123",
                    baseRefName: "main",
                    mergeable: "MERGEABLE",
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

      expect(status).toEqual({
        _tag: expected,
        terminalChecks: [],
        mergeability: "mergeable",
        baseRefName: "main",
      })
    })
  }

  it("treats a not-yet-visible PR as pending and a PR without checks as no_checks", async () => {
    const responses = [
      { repository: { pullRequests: { nodes: [] } } },
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                state: "OPEN",
                merged: false,
                baseRefName: "develop",
                mergeable: "CONFLICTING",
                statusCheckRollup: null,
              },
            ],
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
    ).toEqual({
      _tag: "pending",
      terminalChecks: [],
      mergeability: "unknown",
      baseRefName: null,
    })
    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({
      _tag: "no_checks",
      mergeability: "conflicting",
      baseRefName: "develop",
    })
  })

  it("reports pull request lifecycle status for open, merged, closed, and missing PRs", async () => {
    const responses = [
      {
        repository: {
          pullRequests: {
            nodes: [{ state: "OPEN", merged: false }],
          },
        },
      },
      {
        repository: {
          pullRequests: {
            nodes: [{ state: "MERGED", merged: true }],
          },
        },
      },
      {
        repository: {
          pullRequests: {
            nodes: [{ state: "CLOSED", merged: false }],
          },
        },
      },
      {
        repository: {
          pullRequests: { nodes: [] },
        },
      },
    ]
    const service = makeGitHubService({
      query: () => Promise.resolve(responses.shift()!) as never,
    })

    expect(
      await Effect.runPromise(
        service.getPullRequestLifecycleStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "open" })
    expect(
      await Effect.runPromise(
        service.getPullRequestLifecycleStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "merged" })
    expect(
      await Effect.runPromise(
        service.getPullRequestLifecycleStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "closed" })
    expect(
      await Effect.runPromise(
        service.getPullRequestLifecycleStatus(repository, "branch"),
      ),
    ).toEqual({ _tag: "not_found" })
  })

  it("distinguishes closed and merged PRs from a not-yet-visible PR", async () => {
    const responses = [
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                state: "CLOSED",
                merged: false,
                baseRefName: "main",
                mergeable: "UNKNOWN",
                statusCheckRollup: null,
              },
            ],
          },
        },
      },
      {
        repository: {
          pullRequests: {
            nodes: [
              {
                state: "CLOSED",
                merged: true,
                baseRefName: "main",
                mergeable: "UNKNOWN",
                statusCheckRollup: null,
              },
            ],
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
    ).toEqual({
      _tag: "closed",
      mergeability: "unknown",
      baseRefName: "main",
    })
    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({
      _tag: "succeeded",
      terminalChecks: [],
      mergeability: "unknown",
      baseRefName: "main",
    })
  })

  it("loads terminal CheckRuns and StatusContexts via GraphQL rollup", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  state: "OPEN",
                  merged: false,
                  headRefOid: "sha-head",
                  baseRefName: "main",
                  mergeable: "MERGEABLE",
                  statusCheckRollup: {
                    state: "PENDING",
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          databaseId: 100,
                          name: "unit",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                        {
                          __typename: "CheckRun",
                          databaseId: 101,
                          name: "lint",
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                        },
                        {
                          __typename: "CheckRun",
                          databaseId: 102,
                          name: "e2e",
                          status: "COMPLETED",
                          conclusion: "TIMED_OUT",
                        },
                        {
                          __typename: "CheckRun",
                          databaseId: 103,
                          name: "optional",
                          status: "COMPLETED",
                          conclusion: "SKIPPED",
                        },
                        {
                          __typename: "CheckRun",
                          databaseId: 104,
                          name: "build",
                          status: "IN_PROGRESS",
                          conclusion: null,
                        },
                        {
                          __typename: "StatusContext",
                          id: "SC_1",
                          context: "ci/travis",
                          state: "SUCCESS",
                        },
                        {
                          __typename: "StatusContext",
                          id: "SC_2",
                          context: "ci/deploy",
                          state: "ERROR",
                        },
                        {
                          __typename: "StatusContext",
                          id: "SC_3",
                          context: "ci/pending",
                          state: "PENDING",
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        }) as never,
    })

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(status).toEqual({
      _tag: "pending",
      mergeability: "mergeable",
      baseRefName: "main",
      terminalChecks: [
        { externalId: "actions-job:100", name: "unit", outcome: "green" },
        { externalId: "actions-job:101", name: "lint", outcome: "red" },
        { externalId: "actions-job:102", name: "e2e", outcome: "red" },
        { externalId: "status:SC_1", name: "ci/travis", outcome: "green" },
        { externalId: "status:SC_2", name: "ci/deploy", outcome: "red" },
      ],
    })
  })

  it("loads every GraphQL status-check rollup page", async () => {
    let attempts = 0
    const service = makeGitHubService({
      query: () => {
        attempts += 1
        return Promise.resolve(
          attempts === 1
            ? {
                repository: {
                  pullRequests: {
                    nodes: [
                      {
                        state: "OPEN",
                        merged: false,
                        headRefOid: "sha-head",
                        baseRefName: "main",
                        mergeable: "MERGEABLE",
                        statusCheckRollup: {
                          state: "PENDING",
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                databaseId: 100,
                                name: "unit",
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                              },
                            ],
                            pageInfo: {
                              endCursor: "page-2",
                              hasNextPage: true,
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              }
            : {
                repository: {
                  pullRequests: {
                    nodes: [
                      {
                        statusCheckRollup: {
                          state: "PENDING",
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                databaseId: 101,
                                name: "lint",
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                              },
                            ],
                            pageInfo: {
                              endCursor: null,
                              hasNextPage: false,
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
        ) as never
      },
    })

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(status).toMatchObject({
      terminalChecks: [
        { externalId: "actions-job:100", outcome: "green" },
        { externalId: "actions-job:101", outcome: "red" },
      ],
    })
    expect(attempts).toBe(2)
  })

  it("treats distinct CheckRun executions with the same name as separate", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  state: "OPEN",
                  merged: false,
                  headRefOid: "sha-head",
                  baseRefName: "main",
                  mergeable: "MERGEABLE",
                  statusCheckRollup: {
                    state: "FAILURE",
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          databaseId: 100,
                          name: "lint",
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                        },
                        {
                          __typename: "CheckRun",
                          databaseId: 101,
                          name: "lint",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        }) as never,
    })

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(status).toEqual({
      _tag: "failed",
      mergeability: "mergeable",
      baseRefName: "main",
      terminalChecks: [
        { externalId: "actions-job:100", name: "lint", outcome: "red" },
        { externalId: "actions-job:101", name: "lint", outcome: "green" },
      ],
    })
  })

  it("retries transient GraphQL failures", async () => {
    let attempts = 0
    const service = makeGitHubService({
      query: () => {
        attempts += 1
        if (attempts < 3) {
          return Promise.reject(new Error("temporary outage"))
        }
        return Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  state: "OPEN",
                  merged: false,
                  baseRefName: "main",
                  mergeable: "MERGEABLE",
                  statusCheckRollup: null,
                },
              ],
            },
          },
        }) as never
      },
    })

    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({
      _tag: "no_checks",
      mergeability: "mergeable",
      baseRefName: "main",
    })
    expect(attempts).toBe(3)
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

  it("does not retry failed GraphQL mutations", async () => {
    let mutationAttempts = 0
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
      mutation: () => {
        mutationAttempts += 1
        return Promise.reject(new Error("response lost"))
      },
    })

    await expect(
      Effect.runPromise(
        service.markPullRequestReadyForReview(repository, "branch"),
      ),
    ).rejects.toBeInstanceOf(GitHubRequestError)
    expect(mutationAttempts).toBe(1)
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

  it("merges an open PR and no-ops when already merged", async () => {
    const mutations: unknown[] = []
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOOpen",
                  state: "OPEN",
                  merged: false,
                  headRefOid: "abc123",
                  statusCheckRollup: { state: "SUCCESS" },
                },
              ],
            },
          },
        }) as never,
      mutation: (request) => {
        mutations.push(request)
        return Promise.resolve({
          mergePullRequest: {
            pullRequest: { merged: true, state: "MERGED" },
          },
        }) as never
      },
    })

    await Effect.runPromise(service.mergePullRequest(repository, "branch"))
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      mergePullRequest: {
        __args: {
          input: {
            pullRequestId: "PR_kwDOOpen",
            expectedHeadOid: "abc123",
            mergeMethod: "SQUASH",
          },
        },
      },
    })

    const alreadyMerged = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOMerged",
                  state: "MERGED",
                  merged: true,
                },
              ],
            },
          },
        }) as never,
      mutation: () => {
        throw new Error("mutation should not run for an already merged PR")
      },
    })

    await Effect.runPromise(
      alreadyMerged.mergePullRequest(repository, "branch"),
    )
  })

  it("fails merge when the PR is closed unmerged", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOClosed",
                  state: "CLOSED",
                  merged: false,
                },
              ],
            },
          },
        }) as never,
    })

    const result = await Effect.runPromise(
      Effect.result(service.mergePullRequest(repository, "branch")),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRequestError)
    }
  })

  it("does not merge a PR whose current head checks are not successful", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOPending",
                  state: "OPEN",
                  merged: false,
                  headRefOid: "new-head",
                  statusCheckRollup: { state: "PENDING" },
                },
              ],
            },
          },
        }) as never,
      mutation: () => {
        throw new Error("mutation should not run for unchecked head")
      },
    })

    const result = await Effect.runPromise(
      Effect.result(service.mergePullRequest(repository, "branch")),
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
                closedByPullRequestsReferences: {
                  nodes: [
                    {
                      number: 22,
                      state: "OPEN",
                      merged: false,
                      repository: { nameWithOwner: "acme/widgets" },
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
      closingPullRequests: [],
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
    expect(result[1]?.closingPullRequests).toEqual([
      { number: 22, repository: "acme/widgets", state: "OPEN" },
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
      closedByPullRequestsReferences: {
        __args: { first: 100, includeClosedPrs: true },
        nodes: {
          number: true,
          state: true,
          merged: true,
          repository: { nameWithOwner: true },
        },
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

  it("fetches every open and closed Issue-closing PR page", async () => {
    const requests: unknown[] = []
    const responses = [
      {
        repository: {
          issues: {
            nodes: [
              {
                number: 7,
                title: "Issue with pull requests",
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
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                closedByPullRequestsReferences: {
                  nodes: [
                    {
                      number: 20,
                      state: "CLOSED",
                      merged: false,
                      repository: { nameWithOwner: "acme/widgets" },
                    },
                  ],
                  pageInfo: {
                    endCursor: "pull-request-page-2",
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
            closedByPullRequestsReferences: {
              nodes: [
                {
                  number: 10,
                  state: "CLOSED",
                  merged: true,
                  repository: { nameWithOwner: "acme/widgets" },
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

    expect(result[0]?.closingPullRequests).toEqual([
      { number: 10, repository: "acme/widgets", state: "MERGED" },
      { number: 20, repository: "acme/widgets", state: "CLOSED" },
    ])
    const continuation = requests[1] as {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            __args: {
              first: number
              after: string
              includeClosedPrs: boolean
            }
          }
        }
      }
    }
    expect(
      continuation.repository.issue.closedByPullRequestsReferences.__args,
    ).toEqual({
      first: 100,
      after: "pull-request-page-2",
      includeClosedPrs: true,
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

describe("CLI arguments", () => {
  it.effect("reports a missing argument as a typed failure", () =>
    Effect.gen(function* () {
      const error = yield* decodeArgument(undefined, "owner").pipe(Effect.flip)
      expect(error._tag).toBe("CliArgumentError")
      expect(error.message).toBe("Missing owner argument")
    }),
  )

  it("exits with status 1 for a missing argument", () => {
    const result = spawnSync(
      "bun",
      [
        "--conditions",
        "@ready-for-agent/source",
        "src/bin/get-open-pr-number.ts",
      ],
      {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, GITHUB_TOKEN: "test-token" },
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Missing owner argument")
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
