import { spawnSync } from "node:child_process"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import { decodeArgument } from "../src/bin/cli.js"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  GitHubThrottledError,
  GitHubTlsTrustError,
  INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
  type ReadyLabeledIssue,
  buildReasonDetail,
  extractCauseChain,
  extractErrorCode,
  formatUserFacingError,
  logErrorAnnotations,
  makeGitHubServiceFromToken,
  makeGitHubServiceTest,
  parseReasonDetail,
  sanitizeUserFacingText,
  serializeReasonDetail,
  stripAnsi,
} from "../src/index.js"
import { GenqlError } from "../src/internal/generated/runtime/error.js"
import {
  type GitHubGraphqlClient,
  makeGitHubService,
} from "../src/lib/github-service-live.js"

const repository = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}
const apiRepository = { owner: "acme", name: "widgets" }

const graphqlQueryText = (init?: RequestInit): string => {
  if (typeof init?.body !== "string") {
    return ""
  }
  try {
    const parsed: unknown = JSON.parse(init.body)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "query" in parsed &&
      typeof parsed.query === "string"
    ) {
      return parsed.query
    }
  } catch {
    return ""
  }
  return ""
}

const jsonGraphqlResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })

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
  author: null,
  parent: null,
  parentPosition: null,
  hasChildren: false,
  hierarchySupported: true,
  blockedBy: [],
  closingPullRequests: [],
})

describe("GitHubService live implementation", () => {
  it.effect("normalizes primary reset headers into GitHub Throttled", () =>
    Effect.gen(function* () {
      let requests = 0
      const resetSeconds = Math.floor(Date.now() / 1_000) + 120
      const service = makeGitHubServiceFromToken("token", async () => {
        requests += 1
        return new Response("API rate limit exceeded", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSeconds),
          },
        })
      })

      const error = yield* service.listReadyIssues(repository).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GitHubThrottledError)
      expect(error.retryAt).toBe(resetSeconds * 1_000)
      expect(error.usedFallback).toBe(false)
      expect(requests).toBe(1)
    }),
  )

  it.effect(
    "uses a safe deadline for a recognized primary limit without reset headers",
    () =>
      Effect.gen(function* () {
        const service = makeGitHubServiceFromToken(
          "token",
          async () => new Response("API rate limit exceeded", { status: 403 }),
        )

        const before = Date.now()
        const error = yield* service
          .listReadyIssues(repository)
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubThrottledError)
        expect(error.retryAt).toBeGreaterThanOrEqual(before + 60_000)
        expect(error.usedFallback).toBe(false)
      }),
  )

  it.effect(
    "keeps permission 403 responses as one non-retryable request error",
    () =>
      Effect.gen(function* () {
        let requests = 0
        const service = makeGitHubServiceFromToken("token", async () => {
          requests += 1
          return new Response("Resource not accessible by integration", {
            status: 403,
          })
        })

        const error = yield* service
          .listReadyIssues(repository)
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubRequestError)
        expect(error.retryable).toBe(false)
        expect(requests).toBe(1)
      }),
  )

  it.effect("honors Retry-After and reports zero remaining after success", () =>
    Effect.gen(function* () {
      let reported: GitHubThrottledError | undefined
      const resetSeconds = Math.floor(Date.now() / 1_000) + 120
      const throttled = makeGitHubServiceFromToken(
        "token",
        async () =>
          new Response("secondary rate limit", {
            status: 429,
            headers: { "retry-after": "120" },
          }),
      )
      const throttle = yield* throttled
        .listReadyIssues(repository)
        .pipe(Effect.flip)
      expect(throttle.retryAt).toBeGreaterThan(Date.now() + 119_000)
      expect(throttle.usedFallback).toBe(false)

      const successful = makeGitHubServiceFromToken(
        "token",
        async () =>
          new Response(
            JSON.stringify({ data: { viewer: { login: "octocat" } } }),
            {
              headers: {
                "content-type": "application/json",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(resetSeconds),
              },
            },
          ),
        undefined,
        (error) => {
          reported = error
        },
      )
      expect(yield* successful.getAuthenticatedUserLogin(repository)).toBe(
        "octocat",
      )
      expect(reported?.retryAt).toBe(resetSeconds * 1_000)
    }),
  )

  it.effect(
    "normalizes a recognized GraphQL secondary-limit error without retry",
    () =>
      Effect.gen(function* () {
        let requests = 0
        const service = makeGitHubService({
          query: () => {
            requests += 1
            return Promise.reject(
              new GenqlError(
                [{ message: "You have exceeded a secondary rate limit." }],
                null,
              ),
            )
          },
        })

        const error = yield* service
          .getOpenPullRequestNumber(repository, "rfa/issue-876")
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubThrottledError)
        expect(error.usedFallback).toBe(true)
        expect(requests).toBe(1)
      }),
  )

  it.effect("preserves an HTTP authentication status", () =>
    Effect.gen(function* () {
      let requests = 0
      const service = makeGitHubServiceFromToken("expired-token", async () => {
        requests += 1
        return new Response("Bad credentials", {
          status: 401,
          statusText: "Unauthorized",
        })
      })

      const error = yield* service.listReadyIssues(repository).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GitHubRequestError)
      expect((error as GitHubRequestError).statusCode).toBe(401)
      expect(requests).toBe(1)
    }),
  )

  it.effect(
    "classifies GraphQL repository NOT_FOUND as unavailable and names the token identity",
    () =>
      Effect.gen(function* () {
        let repositoryQueries = 0
        const service = makeGitHubServiceFromToken(
          "token",
          async (_input, init) => {
            const query = graphqlQueryText(init)
            if (query.includes("viewer")) {
              return jsonGraphqlResponse({
                data: { viewer: { login: "octocat" } },
              })
            }
            repositoryQueries += 1
            return jsonGraphqlResponse({
              data: { repository: null },
              errors: [
                {
                  type: "NOT_FOUND",
                  path: ["repository"],
                  message:
                    "Could not resolve to a Repository with the name 'acme/widgets'.",
                },
              ],
            })
          },
        )

        const error = yield* service
          .getPullRequestCheckStatus(repository, "rfa/acme-widgets/8/wi-1")
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubRepositoryUnavailableError)
        expect(error).not.toBeInstanceOf(GitHubRequestError)
        expect(formatUserFacingError(error)).toBe(
          "acme/widgets is not visible to GitHub user octocat — it may not exist, or that account may not have access",
        )
        expect(
          error instanceof GitHubRepositoryUnavailableError
            ? error.authenticatedLogin
            : undefined,
        ).toBe("octocat")
        expect(repositoryQueries).toBe(1)
      }),
  )

  it.effect(
    "propagates a throttle from the identity lookup after repository NOT_FOUND",
    () =>
      Effect.gen(function* () {
        const resetSeconds = Math.floor(Date.now() / 1_000) + 120
        const service = makeGitHubServiceFromToken(
          "token",
          async (_input, init) => {
            const query = graphqlQueryText(init)
            if (query.includes("viewer")) {
              return new Response("API rate limit exceeded", {
                status: 403,
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": String(resetSeconds),
                },
              })
            }
            return jsonGraphqlResponse({
              data: { repository: null },
              errors: [
                {
                  type: "NOT_FOUND",
                  path: ["repository"],
                  message:
                    "Could not resolve to a Repository with the name 'acme/widgets'.",
                },
              ],
            })
          },
        )

        const error = yield* service
          .getPullRequestCheckStatus(repository, "rfa/acme-widgets/8/wi-1")
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubThrottledError)
        expect(error.retryAt).toBe(resetSeconds * 1_000)
      }),
  )

  it.effect(
    "keeps GraphQL NOT_FOUND on a nested field as a non-retryable request error",
    () =>
      Effect.gen(function* () {
        let requests = 0
        const service = makeGitHubService({
          query: () => {
            requests += 1
            return Promise.reject(
              new GenqlError(
                [
                  {
                    type: "NOT_FOUND",
                    path: ["repository", "issue"],
                    message:
                      "Could not resolve to an Issue with the number of 99.",
                  },
                ],
                { repository: { issue: null } },
              ),
            )
          },
        })

        const error = yield* service
          .ensureIssueCompletedWithSummary(
            repository,
            99,
            "wi-01HXSQK2KG72RRYVWEQH4S83FK",
            "## Summary",
          )
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubRequestError)
        expect((error as GitHubRequestError).retryable).toBe(false)
        expect(requests).toBe(1)
      }),
  )

  it("retries HTTP 5xx as a retryable request error", async () => {
    let requests = 0
    const service = makeGitHubServiceFromToken("token", async () => {
      requests += 1
      return new Response("backend unavailable", {
        status: 502,
        statusText: "Bad Gateway",
      })
    })

    const error = await Effect.runPromise(
      service
        .getPullRequestCheckStatus(repository, "rfa/acme-widgets/8/wi-1")
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).statusCode).toBe(502)
    expect((error as GitHubRequestError).retryable).toBe(true)
    expect(requests).toBe(3)
  })

  it.effect(
    "classifies TLS certificate trust failures as non-retryable GitHubTlsTrustError",
    () =>
      Effect.gen(function* () {
        let requests = 0
        const openssl = Object.assign(
          new Error("self-signed certificate in certificate chain"),
          { code: "SELF_SIGNED_CERT_IN_CHAIN" },
        )
        const service = makeGitHubServiceFromToken("token", async () => {
          requests += 1
          throw new TypeError("fetch failed", { cause: openssl })
        })

        const error = yield* service
          .listReadyIssues(repository)
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubTlsTrustError)
        expect(error._tag).toBe("GitHubTlsTrustError")
        expect(error.code).toBe("SELF_SIGNED_CERT_IN_CHAIN")
        expect(error.host).toBe("api.github.com")
        expect(error.message).toContain("NODE_EXTRA_CA_CERTS")
        expect(error.message).toContain("trusted TLS connection")
        // Permanent for the process: no bounded query retries.
        expect(requests).toBe(1)
      }),
  )

  it.effect(
    "does not retry UNABLE_TO_VERIFY_LEAF_SIGNATURE as a transient error",
    () =>
      Effect.gen(function* () {
        let requests = 0
        const openssl = Object.assign(new Error("unable to verify"), {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        })
        const service = makeGitHubServiceFromToken("token", async () => {
          requests += 1
          throw new TypeError("fetch failed", { cause: openssl })
        })

        const error = yield* service
          .getOpenPullRequestNumber(repository, "rfa/branch")
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubTlsTrustError)
        expect(error.code).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE")
        expect(requests).toBe(1)
      }),
  )

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
        __args: apiRepository,
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

  it("soft-finds an open pull request number or null", async () => {
    const missing = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: { pullRequests: { nodes: [] } },
        }) as never,
    })
    expect(
      await Effect.runPromise(
        missing.findOpenPullRequestNumber(repository, "rfa/issue-42"),
      ),
    ).toBeNull()

    const present = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: { pullRequests: { nodes: [{ number: 99 }] } },
        }) as never,
    })
    expect(
      await Effect.runPromise(
        present.findOpenPullRequestNumber(repository, "rfa/issue-42"),
      ),
    ).toBe(99)
  })

  it("closes every matching open pull request sequentially before deleting its branch", async () => {
    const mutations: unknown[] = []
    let queries = 0
    const service = makeGitHubService({
      query: () => {
        queries += 1
        return Promise.resolve(
          queries === 1
            ? {
                repository: {
                  pullRequests: {
                    nodes: [
                      { id: "PR_1", state: "OPEN" },
                      { id: "PR_2", state: "OPEN" },
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              }
            : { repository: { ref: { id: "REF_branch" } } },
        ) as never
      },
      mutation: (request) => {
        mutations.push(request)
        if (mutations.length < 3) {
          return Promise.resolve({
            updatePullRequest: { pullRequest: { state: "CLOSED" } },
          }) as never
        }
        return Promise.resolve({
          deleteRef: { clientMutationId: null },
        }) as never
      },
    })

    await Effect.runPromise(
      service.closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881"),
    )

    expect(mutations).toHaveLength(3)
    expect(mutations[0]).toMatchObject({
      updatePullRequest: {
        __args: { input: { pullRequestId: "PR_1", state: "CLOSED" } },
      },
    })
    expect(mutations[1]).toMatchObject({
      updatePullRequest: {
        __args: { input: { pullRequestId: "PR_2", state: "CLOSED" } },
      },
    })
    expect(mutations[2]).toMatchObject({
      deleteRef: { __args: { input: { refId: "REF_branch" } } },
    })
  })

  it("closes one matching open pull request before deleting its branch", async () => {
    const mutations: unknown[] = []
    let queries = 0
    const service = makeGitHubService({
      query: () => {
        queries += 1
        return Promise.resolve(
          queries === 1
            ? {
                repository: {
                  pullRequests: {
                    nodes: [{ id: "PR_1", state: "OPEN" }],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              }
            : { repository: { ref: { id: "REF_branch" } } },
        ) as never
      },
      mutation: (request) => {
        mutations.push(request)
        return Promise.resolve(
          mutations.length === 1
            ? { updatePullRequest: { pullRequest: { state: "CLOSED" } } }
            : { deleteRef: { clientMutationId: null } },
        ) as never
      },
    })

    await Effect.runPromise(
      service.closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881"),
    )

    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatchObject({
      updatePullRequest: {
        __args: { input: { pullRequestId: "PR_1", state: "CLOSED" } },
      },
    })
    expect(mutations[1]).toMatchObject({
      deleteRef: { __args: { input: { refId: "REF_branch" } } },
    })
  })

  it("returns a typed request error for malformed cleanup data", async () => {
    const service = makeGitHubService({
      query: () => Promise.resolve({ repository: {} }) as never,
    })

    const error = await Effect.runPromise(
      service
        .closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881")
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect(error.message).toContain("invalid open pull request data")
  })

  it("treats zero matching pull requests and a missing branch as cleanup success", async () => {
    let queries = 0
    let mutations = 0
    const service = makeGitHubService({
      query: () => {
        queries += 1
        return Promise.resolve(
          queries === 1
            ? {
                repository: {
                  pullRequests: {
                    nodes: [],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              }
            : { repository: { ref: null } },
        ) as never
      },
      mutation: () => {
        mutations += 1
        return Promise.resolve({}) as never
      },
    })

    await Effect.runPromise(
      service.closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881"),
    )

    expect(queries).toBe(2)
    expect(mutations).toBe(0)
  })

  it("keeps a malformed branch-delete response distinguishable from throttling", async () => {
    let queries = 0
    const service = makeGitHubService({
      query: () => {
        queries += 1
        return Promise.resolve(
          queries === 1
            ? {
                repository: {
                  pullRequests: {
                    nodes: [],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              }
            : { repository: { ref: { id: "REF_branch" } } },
        ) as never
      },
      mutation: () => Promise.resolve({ deleteRef: null }) as never,
    })

    const error = await Effect.runPromise(
      service
        .closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881")
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect(error.message).toContain("did not confirm remote branch deletion")
  })

  it("returns a typed request error for malformed pull request closure data", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [{ id: "PR_1", state: "OPEN" }],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        }) as never,
      mutation: () => Promise.resolve(null) as never,
    })

    const error = await Effect.runPromise(
      service
        .closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881")
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect(error.message).toContain("invalid pull request closure data")
  })

  it("returns a typed request error for malformed branch deletion data", async () => {
    let queries = 0
    const service = makeGitHubService({
      query: () => {
        queries += 1
        return Promise.resolve(
          queries === 1
            ? {
                repository: {
                  pullRequests: {
                    nodes: [],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              }
            : { repository: { ref: { id: "REF_branch" } } },
        ) as never
      },
      mutation: () => Promise.resolve({}) as never,
    })

    const error = await Effect.runPromise(
      service
        .closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881")
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect(error.message).toContain("invalid remote branch deletion data")
  })

  it("replays partial cleanup without re-closing an already-closed pull request", async () => {
    let attempt = 0
    const closedPullRequests: string[] = []
    const service = makeGitHubService({
      query: () => {
        attempt += 1
        if (attempt === 1) {
          return Promise.resolve({
            repository: {
              pullRequests: {
                nodes: [
                  { id: "PR_1", state: "OPEN" },
                  { id: "PR_2", state: "OPEN" },
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          }) as never
        }
        if (attempt === 2) {
          return Promise.resolve({
            repository: {
              pullRequests: {
                nodes: [{ id: "PR_2", state: "OPEN" }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: { ref: { id: "REF_branch" } },
        }) as never
      },
      mutation: (request) => {
        const update = "updatePullRequest" in request
        if (update) {
          const id = request.updatePullRequest.__args.input.pullRequestId
          closedPullRequests.push(id)
          if (id === "PR_2" && closedPullRequests.length === 2) {
            return Promise.reject(
              new GitHubThrottledError({
                retryAt: Date.now() + 60_000,
                usedFallback: false,
              }),
            )
          }
          return Promise.resolve({
            updatePullRequest: { pullRequest: { state: "CLOSED" } },
          }) as never
        }
        return Promise.resolve({
          deleteRef: { clientMutationId: null },
        }) as never
      },
    })

    const throttled = await Effect.runPromise(
      service
        .closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881")
        .pipe(Effect.flip),
    )
    expect(throttled).toBeInstanceOf(GitHubThrottledError)

    await Effect.runPromise(
      service.closeOpenPullRequestsAndDeleteBranch(repository, "rfa/issue-881"),
    )
    expect(closedPullRequests).toEqual(["PR_1", "PR_2", "PR_2"])
  })

  it("updates open draft PR copy and leaves non-draft PRs unchanged", async () => {
    const mutations: unknown[] = []
    const draftService = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_draft",
                  number: 12,
                  isDraft: true,
                  title: "old",
                  body: "old body",
                },
              ],
            },
          },
        }) as never,
      mutation: (input) => {
        mutations.push(input)
        return Promise.resolve({
          updatePullRequest: { pullRequest: { number: 12 } },
        }) as never
      },
    })
    expect(
      await Effect.runPromise(
        draftService.updateOpenDraftPullRequestCopy(
          repository,
          "rfa/issue-12",
          { title: "new title", body: "new body\n\nCloses #12" },
        ),
      ),
    ).toBe(12)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      updatePullRequest: {
        __args: {
          input: {
            pullRequestId: "PR_draft",
            title: "new title",
            body: "new body\n\nCloses #12",
          },
        },
      },
    })

    const readyMutations: unknown[] = []
    const readyService = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_ready",
                  number: 13,
                  isDraft: false,
                  title: "human",
                  body: "human body",
                },
              ],
            },
          },
        }) as never,
      mutation: (input) => {
        readyMutations.push(input)
        return Promise.resolve({}) as never
      },
    })
    expect(
      await Effect.runPromise(
        readyService.updateOpenDraftPullRequestCopy(
          repository,
          "rfa/issue-13",
          { title: "should not apply", body: "should not apply" },
        ),
      ),
    ).toBe(13)
    expect(readyMutations).toHaveLength(0)

    // Mutation failure after a successful draft lookup still returns the PR number.
    const failService = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_draft_fail",
                  number: 14,
                  isDraft: true,
                  title: "old",
                  body: "old",
                },
              ],
            },
          },
        }) as never,
      mutation: () => Promise.reject(new Error("rate limited")),
    })
    expect(
      await Effect.runPromise(
        failService.updateOpenDraftPullRequestCopy(repository, "rfa/issue-14", {
          title: "new",
          body: "new",
        }),
      ),
    ).toBe(14)
  })

  it("creates a draft pull request against the repository default base", async () => {
    const queries: unknown[] = []
    const mutations: unknown[] = []
    const service = makeGitHubService({
      query: (input) => {
        queries.push(input)
        return Promise.resolve({
          repository: {
            id: "repo-node-1",
            defaultBranchRef: { name: "main" },
          },
        }) as never
      },
      mutation: (input) => {
        mutations.push(input)
        return Promise.resolve({
          createPullRequest: {
            pullRequest: { number: 4242 },
          },
        }) as never
      },
    })

    expect(
      await Effect.runPromise(
        service.createDraftPullRequest(repository, {
          headRefName: "rfa/issue-42",
          title: "Ship widgets",
          body: "Closes #42",
        }),
      ),
    ).toBe(4242)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      createPullRequest: {
        __args: {
          input: {
            repositoryId: "repo-node-1",
            baseRefName: "main",
            headRefName: "rfa/issue-42",
            title: "Ship widgets",
            body: "Closes #42",
            draft: true,
          },
        },
      },
    })
    expect(queries).toHaveLength(1)
  })

  it("counts open non-draft pull requests across pages and excludes drafts", async () => {
    const requests: unknown[] = []
    const pages = [
      {
        repository: {
          pullRequests: {
            nodes: [
              { isDraft: false },
              { isDraft: true },
              { isDraft: false },
              null,
            ],
            pageInfo: { endCursor: "page-2", hasNextPage: true },
          },
        },
      },
      {
        repository: {
          pullRequests: {
            nodes: [{ isDraft: false }, { isDraft: true }],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    ]
    const service = makeGitHubService({
      query: (input) => {
        requests.push(input)
        return Promise.resolve(pages.shift()!) as never
      },
    })

    expect(
      await Effect.runPromise(
        service.countOpenNonDraftPullRequests(repository),
      ),
    ).toBe(3)
    expect(requests).toEqual([
      {
        repository: {
          __args: apiRepository,
          pullRequests: {
            __args: {
              first: 100,
              states: ["OPEN"],
            },
            nodes: { isDraft: true },
            pageInfo: { endCursor: true, hasNextPage: true },
          },
        },
      },
      {
        repository: {
          __args: apiRepository,
          pullRequests: {
            __args: {
              first: 100,
              states: ["OPEN"],
              after: "page-2",
            },
            nodes: { isDraft: true },
            pageInfo: { endCursor: true, hasNextPage: true },
          },
        },
      },
    ])
  })

  it("returns zero open non-draft pull requests when GitHub has none", async () => {
    const service = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        }) as never,
    })

    expect(
      await Effect.runPromise(
        service.countOpenNonDraftPullRequests(repository),
      ),
    ).toBe(0)
  })

  it("fails when the repository is unavailable for open non-draft PR count", async () => {
    const service = makeGitHubService({
      query: () => Promise.resolve({ repository: null }) as never,
    })

    const result = await Effect.runPromise(
      service.countOpenNonDraftPullRequests(repository).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRepositoryUnavailableError)
    }
  })

  for (const [state, expected] of [
    ["PENDING", "pending"],
    ["EXPECTED", "expected"],
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
        headPushedAt: null,
        headSha: "abc123",
        createdAt: null,
        isDraft: null,
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
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    })
    expect(
      await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "branch"),
      ),
    ).toEqual({
      _tag: "no_checks",
      mergeability: "conflicting",
      baseRefName: "develop",
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    })
  })

  it("reads PR creation, draft state, and current head commit pushedDate", async () => {
    let request: unknown
    const service = makeGitHubService({
      query: (input) => {
        request = input
        return Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  state: "OPEN",
                  merged: false,
                  isDraft: true,
                  createdAt: "2026-07-17T11:00:00.000Z",
                  headRefOid: "abc123",
                  baseRefName: "main",
                  mergeable: "MERGEABLE",
                  statusCheckRollup: null,
                  commits: {
                    nodes: [
                      {
                        commit: {
                          oid: "abc123",
                          pushedDate: "2026-07-17T12:00:00.000Z",
                        },
                      },
                    ],
                  },
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
      headPushedAt: new Date("2026-07-17T12:00:00.000Z"),
      headSha: "abc123",
      createdAt: new Date("2026-07-17T11:00:00.000Z"),
      isDraft: true,
    })
    expect(request).toMatchObject({
      repository: {
        pullRequests: {
          nodes: {
            isDraft: true,
            createdAt: true,
            commits: {
              __args: { last: 1 },
              nodes: {
                commit: {
                  oid: true,
                  pushedDate: true,
                },
              },
            },
          },
        },
      },
    })
  })

  it("ignores invalid, mismatched, null, and malformed head push timestamps", async () => {
    const cases = [
      {
        headRefOid: "abc123",
        commits: {
          nodes: [
            {
              commit: {
                oid: "other",
                pushedDate: "2026-07-17T12:00:00.000Z",
              },
            },
          ],
        },
      },
      {
        headRefOid: "abc123",
        commits: {
          nodes: [{ commit: { oid: "abc123", pushedDate: null } }],
        },
      },
      {
        headRefOid: "abc123",
        commits: {
          nodes: [{ commit: { oid: "abc123", pushedDate: "not-a-date" } }],
        },
      },
      {
        headRefOid: "abc123",
        commits: { nodes: [] },
      },
      {
        headRefOid: "abc123",
        commits: null,
      },
    ] as const

    for (const pullRequest of cases) {
      const service = makeGitHubService({
        query: () =>
          Promise.resolve({
            repository: {
              pullRequests: {
                nodes: [
                  {
                    state: "OPEN",
                    merged: false,
                    baseRefName: "main",
                    mergeable: "MERGEABLE",
                    statusCheckRollup: null,
                    ...pullRequest,
                  },
                ],
              },
            },
          }) as never,
      })

      expect(
        await Effect.runPromise(
          service.getPullRequestCheckStatus(repository, "branch"),
        ),
      ).toEqual({
        _tag: "no_checks",
        mergeability: "mergeable",
        baseRefName: "main",
        headPushedAt: null,
        headSha: "abc123",
        createdAt: null,
        isDraft: null,
      })
    }
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
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
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
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    })
  })

  it("loads terminal checks via REST when the rollup is pending or red", async () => {
    let listedSha: string | undefined
    const service = makeGitHubService(
      {
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
                    statusCheckRollup: { state: "PENDING" },
                  },
                ],
              },
            },
          }) as never,
      },
      async (_repository, headSha) => {
        listedSha = headSha
        return [
          { externalId: "actions-job:100", name: "unit", outcome: "green" },
          { externalId: "actions-job:101", name: "lint", outcome: "red" },
          { externalId: "actions-job:102", name: "e2e", outcome: "red" },
        ]
      },
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(listedSha).toBe("sha-head")
    expect(status).toEqual({
      _tag: "pending",
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: "sha-head",
      createdAt: null,
      isDraft: null,
      terminalChecks: [
        { externalId: "actions-job:100", name: "unit", outcome: "green" },
        { externalId: "actions-job:101", name: "lint", outcome: "red" },
        { externalId: "actions-job:102", name: "e2e", outcome: "red" },
      ],
    })
  })

  it("loads terminal checks when the rollup is already green", async () => {
    let listed = false
    const service = makeGitHubService(
      {
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
                    statusCheckRollup: { state: "SUCCESS" },
                  },
                ],
              },
            },
          }) as never,
      },
      async () => {
        listed = true
        return [
          { externalId: "actions-job:100", name: "unit", outcome: "green" },
        ]
      },
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(listed).toBe(true)
    expect(status).toEqual({
      _tag: "succeeded",
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: "sha-head",
      createdAt: null,
      isDraft: null,
      terminalChecks: [
        { externalId: "actions-job:100", name: "unit", outcome: "green" },
      ],
    })
  })

  it("treats distinct check executions with the same name as separate", async () => {
    const service = makeGitHubService(
      {
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
                    statusCheckRollup: { state: "FAILURE" },
                  },
                ],
              },
            },
          }) as never,
      },
      async () => [
        { externalId: "actions-job:100", name: "lint", outcome: "red" },
        { externalId: "actions-job:101", name: "lint", outcome: "green" },
      ],
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(status).toEqual({
      _tag: "failed",
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: "sha-head",
      createdAt: null,
      isDraft: null,
      terminalChecks: [
        { externalId: "actions-job:100", name: "lint", outcome: "red" },
        { externalId: "actions-job:101", name: "lint", outcome: "green" },
      ],
    })
  })

  it("falls back to Actions jobs when Checks REST returns 403", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("api.github.com/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      state: "OPEN",
                      merged: false,
                      headRefOid: "sha-head",
                      baseRefName: "main",
                      mergeable: "MERGEABLE",
                      statusCheckRollup: { state: "FAILURE" },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({
            message: "Resource not accessible by personal access token",
          }),
          { status: 403, statusText: "Forbidden" },
        )
      }
      if (url.includes("/actions/runs?") || url.includes("/actions/runs&")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            workflow_runs: [{ id: 55, name: "CI" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/actions/runs/55/jobs")) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 200,
                name: "lint",
                status: "completed",
                conclusion: "failure",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/statuses")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(status).toEqual({
      _tag: "failed",
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: "sha-head",
      createdAt: null,
      isDraft: null,
      terminalChecks: [
        { externalId: "actions-job:200", name: "CI/lint", outcome: "red" },
      ],
    })
  })

  it.effect("does not fall back from a throttled Checks API response", () =>
    Effect.gen(function* () {
      let actionsRequests = 0
      const resetSeconds = Math.floor(Date.now() / 1_000) + 120
      const service = makeGitHubServiceFromToken("token", async (input) => {
        const url = String(input)
        if (url.includes("api.github.com/graphql")) {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequests: {
                    nodes: [
                      {
                        state: "OPEN",
                        merged: false,
                        headRefOid: "sha-head",
                        baseRefName: "main",
                        mergeable: "MERGEABLE",
                        statusCheckRollup: { state: "FAILURE" },
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url.includes("/check-runs")) {
          return new Response("API rate limit exceeded", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetSeconds),
            },
          })
        }
        if (url.includes("/actions/")) {
          actionsRequests += 1
          return new Response(
            JSON.stringify({ total_count: 0, workflow_runs: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url.includes("/statuses")) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response("not found", { status: 404 })
      })

      const error = yield* service
        .getPullRequestCheckStatus(repository, "branch")
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(GitHubThrottledError)
      expect(error.retryAt).toBe(resetSeconds * 1_000)
      expect(actionsRequests).toBe(0)
    }),
  )

  it("maps the production success+skipped Actions fallback shape and excludes skipped jobs", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("api.github.com/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      state: "OPEN",
                      merged: false,
                      headRefOid: "sha-head",
                      baseRefName: "main",
                      mergeable: "MERGEABLE",
                      statusCheckRollup: { state: "SUCCESS" },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({
            message: "Resource not accessible by personal access token",
          }),
          { status: 403, statusText: "Forbidden" },
        )
      }
      if (url.includes("/actions/runs?") || url.includes("/actions/runs&")) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            workflow_runs: [
              { id: 29906669357, name: "PR Review" },
              { id: 29906669358, name: "Claude Code Review" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/actions/runs/29906669357/jobs")) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1001,
                name: "main",
                status: "completed",
                conclusion: "success",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/actions/runs/29906669358/jobs")) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1002,
                name: "claude-review",
                status: "completed",
                conclusion: "skipped",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/statuses")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(status).toEqual({
      _tag: "succeeded",
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: "sha-head",
      createdAt: null,
      isDraft: null,
      terminalChecks: [
        {
          externalId: "actions-job:1001",
          name: "PR Review/main",
          outcome: "green",
        },
      ],
    })
  })

  it("reruns a whole Actions workflow run via REST", async () => {
    const calls: string[] = []
    const service = makeGitHubServiceFromToken("token", async (input, init) => {
      const url = String(input)
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (
        url.includes("/actions/runs/29906669357/rerun") &&
        init?.method === "POST"
      ) {
        return new Response(null, { status: 201 })
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    await Effect.runPromise(service.rerunWorkflowRun(repository, 29906669357))
    expect(calls).toEqual([
      "POST https://api.github.com/repos/acme/widgets/actions/runs/29906669357/rerun",
    ])
  })

  it("loads Actions job log diagnostics for actions-job external ids", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("/actions/jobs/200/logs")) {
        return new Response(
          "line 1\nerror TS6305: Output file has not been built\nline 3\n",
          {
            status: 200,
            headers: { "content-type": "text/plain" },
          },
        )
      }
      if (url.includes("/actions/jobs/200")) {
        return new Response(
          JSON.stringify({
            id: 200,
            name: "lint",
            html_url: "https://github.com/acme/widgets/actions/runs/55/job/200",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const diagnostics = await Effect.runPromise(
      service.getPrStatusCheckDiagnostics(
        repository,
        [{ externalId: "actions-job:200", name: "lint" }],
        { maxExcerptChars: 80 },
      ),
    )

    expect(diagnostics).toEqual([
      {
        externalId: "actions-job:200",
        name: "lint",
        source: "actions-job",
        htmlUrl: "https://github.com/acme/widgets/actions/runs/55/job/200",
        logFetch: {
          _tag: "ok",
          excerpt:
            "line 1\nerror TS6305: Output file has not been built\nline 3\n",
          localPath: null,
        },
      },
    ])
  })

  it.effect(
    "propagates Actions job log throttles to the coordinator boundary",
    () =>
      Effect.gen(function* () {
        const service = makeGitHubServiceFromToken("token", async (input) => {
          const url = String(input)
          if (url.includes("/actions/jobs/200")) {
            return new Response("You have exceeded a secondary rate limit.", {
              status: 429,
            })
          }
          return new Response("not found", {
            status: 404,
            statusText: "Not Found",
          })
        })

        const error = yield* service
          .getPrStatusCheckDiagnostics(repository, [
            { externalId: "actions-job:200", name: "lint" },
          ])
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(GitHubThrottledError)
        expect(error.usedFallback).toBe(true)
      }),
  )

  it("marks commit-status diagnostics unavailable without treating them as hard failure", async () => {
    const service = makeGitHubServiceFromToken("token", async () => {
      throw new Error("should not call GitHub for status diagnostics")
    })

    const diagnostics = await Effect.runPromise(
      service.getPrStatusCheckDiagnostics(repository, [
        { externalId: "status:ci/travis", name: "ci/travis" },
      ]),
    )

    expect(diagnostics).toEqual([
      {
        externalId: "status:ci/travis",
        name: "ci/travis",
        source: "status",
        htmlUrl: null,
        logFetch: {
          _tag: "unavailable",
          reason:
            "Commit status contexts do not expose Actions job logs; inspect the status target URL if present",
        },
      },
    ])
  })

  it("observes no automated-review evidence for ordinary green CI and skipped recognized reviewers", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("/pulls?") && url.includes("state=open")) {
        return new Response(JSON.stringify([{ number: 42 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/issues/42/comments")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/pulls/42/comments")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/pulls/42/reviews")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/actions/jobs/100")) {
        return new Response(
          JSON.stringify({
            id: 100,
            name: "claude-review",
            conclusion: "skipped",
            steps: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/actions/jobs/101")) {
        throw new Error("should not load ordinary CI job steps")
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const observation = await Effect.runPromise(
      service.observeAutomatedReviewEvidence(
        repository,
        "rfa/acme-widgets/42/wi-1",
        [
          {
            externalId: "actions-job:100",
            name: "Claude Code Review/claude-review",
          },
          { externalId: "actions-job:101", name: "PR Review/main" },
        ],
      ),
    )

    expect(observation).toEqual({
      _tag: "none",
      reason: "green-no-review-evidence",
    })
  })

  it("observes positive evidence when a recognized reviewer job executed steps", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("/pulls?") && url.includes("state=open")) {
        return new Response(JSON.stringify([{ number: 7 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (
        url.includes("/issues/7/comments") ||
        url.includes("/pulls/7/comments") ||
        url.includes("/pulls/7/reviews")
      ) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/actions/jobs/300")) {
        return new Response(
          JSON.stringify({
            id: 300,
            name: "claude-review",
            conclusion: "success",
            steps: [
              { name: "Checkout", conclusion: "success" },
              { name: "Run Claude", conclusion: "success" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const observation = await Effect.runPromise(
      service.observeAutomatedReviewEvidence(repository, "feature/review", [
        {
          externalId: "actions-job:300",
          name: "Claude Code Review/claude-review",
        },
      ]),
    )

    expect(observation._tag).toBe("positive")
    if (observation._tag === "positive") {
      expect(observation.kind).toBe("executed_reviewer_job")
    }
  })

  it("treats recognized reviewer success without job steps as ambiguous", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("/pulls?") && url.includes("state=open")) {
        return new Response(JSON.stringify([{ number: 8 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (
        url.includes("/issues/8/comments") ||
        url.includes("/pulls/8/comments") ||
        url.includes("/pulls/8/reviews")
      ) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/actions/jobs/301")) {
        return new Response(
          JSON.stringify({
            id: 301,
            name: "claude-review",
            conclusion: "success",
            steps: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const observation = await Effect.runPromise(
      service.observeAutomatedReviewEvidence(repository, "feature/no-steps", [
        {
          externalId: "actions-job:301",
          name: "Claude Code Review/claude-review",
        },
      ]),
    )

    expect(observation._tag).toBe("ambiguous")
    if (observation._tag === "ambiguous") {
      expect(observation.reason).toContain("without inspectable steps")
    }
  })

  it("observes positive evidence from a recognized automated-review comment", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("/pulls?") && url.includes("state=open")) {
        return new Response(JSON.stringify([{ number: 9 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/issues/9/comments")) {
        return new Response(
          JSON.stringify([
            {
              user: { login: "claude[bot]" },
              body: "**Claude finished**\n\n## Findings\nAll good.\n- [x] Aggregate findings and post review",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const observation = await Effect.runPromise(
      service.observeAutomatedReviewEvidence(repository, "feature/comment", [
        { externalId: "actions-job:1", name: "lint" },
      ]),
    )

    expect(observation).toEqual({
      _tag: "positive",
      kind: "review_comment",
      detail: "Issue comment from claude[bot]",
    })
  })

  it("observes incomplete Automated Review Output from the latest recognized comment body", async () => {
    const incompleteBody = `**Claude finished @berenddeboer's task in 2m 35s** —— [View job](https://github.com/acme/widgets/actions/runs/31549139160)

### Claude is reviewing this PR
- [x] Gather context
- [ ] Aggregate findings and post review
`
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("/pulls?") && url.includes("state=open")) {
        return new Response(JSON.stringify([{ number: 11 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/issues/11/comments")) {
        return new Response(
          JSON.stringify([
            {
              user: { login: "claude[bot]" },
              body: "**Claude finished**\n\n## Findings\nold complete attempt\n- [x] Aggregate findings and post review",
            },
            {
              user: { login: "claude[bot]" },
              body: incompleteBody,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const observation = await Effect.runPromise(
      service.observeAutomatedReviewEvidence(repository, "feature/incomplete", [
        {
          externalId: "actions-job:400",
          name: "Claude Code Review/claude-review",
        },
      ]),
    )

    expect(observation).toEqual({
      _tag: "incomplete",
      signature: INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
      workflowRunId: 31549139160,
      workflowName: "Claude Code Review",
      detail: "Visibly incomplete automated review comment from claude[bot]",
    })
  })

  it("loads only the latest commit status for each context", async () => {
    const service = makeGitHubServiceFromToken("token", async (input) => {
      const url = String(input)
      if (url.includes("api.github.com/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      state: "OPEN",
                      merged: false,
                      headRefOid: "sha-head",
                      baseRefName: "main",
                      mergeable: "MERGEABLE",
                      statusCheckRollup: { state: "FAILURE" },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/statuses")) {
        return new Response(
          JSON.stringify([
            {
              id: 3,
              node_id: "SC_3",
              context: "ci/build",
              state: "failure",
            },
            {
              id: 2,
              node_id: "SC_2",
              context: "ci/build",
              state: "success",
            },
            {
              id: 1,
              node_id: "SC_1",
              context: "ci/deploy",
              state: "success",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404, statusText: "Not Found" })
    })

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "branch"),
    )

    expect(status).toMatchObject({
      _tag: "failed",
      terminalChecks: [
        { externalId: "status:SC_1", name: "ci/deploy", outcome: "green" },
        { externalId: "status:SC_3", name: "ci/build", outcome: "red" },
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
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
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
                  mergeable: "MERGEABLE",
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

  it("returns a human outcome when the PR is closed unmerged", async () => {
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
      service.mergePullRequest(repository, "branch"),
    )
    expect(result).toMatchObject({
      _tag: "needs_human",
      reason: "closed_unmerged",
    })
  })

  it.each([
    ["non-green checks", "MERGEABLE", "FAILURE", "checks_not_green"],
    ["a conflict", "CONFLICTING", "SUCCESS", "mergeability_changed"],
    ["unknown mergeability", "UNKNOWN", "SUCCESS", "mergeability_changed"],
  ] as const)(
    "returns a revalidation outcome for %s",
    async (_description, mergeable, checkState, reason) => {
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
                    mergeable,
                    statusCheckRollup: { state: checkState },
                  },
                ],
              },
            },
          }) as never,
      })

      const result = await Effect.runPromise(
        service.mergePullRequest(repository, "branch"),
      )
      expect(result).toMatchObject({ _tag: "revalidation", reason })
    },
  )

  it.each([
    [
      "a changed head",
      {
        state: "OPEN",
        merged: false,
        headRefOid: "def456",
        mergeable: "MERGEABLE",
        statusCheckRollup: { state: "SUCCESS" },
      },
      "revalidation",
      "head_changed",
    ],
    [
      "newly non-green checks",
      {
        state: "OPEN",
        merged: false,
        headRefOid: "abc123",
        mergeable: "MERGEABLE",
        statusCheckRollup: { state: "PENDING" },
      },
      "revalidation",
      "checks_not_green",
    ],
    [
      "changed mergeability",
      {
        state: "OPEN",
        merged: false,
        headRefOid: "abc123",
        mergeable: "CONFLICTING",
        statusCheckRollup: { state: "SUCCESS" },
      },
      "revalidation",
      "mergeability_changed",
    ],
    [
      "an unchanged rejected merge",
      {
        state: "OPEN",
        merged: false,
        headRefOid: "abc123",
        mergeable: "MERGEABLE",
        statusCheckRollup: { state: "SUCCESS" },
      },
      "needs_human",
      "merge_rejected",
    ],
  ] as const)(
    "classifies %s returned by the merge mutation",
    async (_description, pullRequest, tag, reason) => {
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
                    mergeable: "MERGEABLE",
                    statusCheckRollup: { state: "SUCCESS" },
                  },
                ],
              },
            },
          }) as never,
        mutation: () =>
          Promise.resolve({ mergePullRequest: { pullRequest } }) as never,
      })

      const result = await Effect.runPromise(
        service.mergePullRequest(repository, "branch"),
      )
      expect(result).toMatchObject({ _tag: tag, reason })
    },
  )

  it("keeps malformed merge responses as operational failures", async () => {
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
                  mergeable: "MERGEABLE",
                  statusCheckRollup: { state: "SUCCESS" },
                },
              ],
            },
          },
        }) as never,
      mutation: () => Promise.resolve({ mergePullRequest: null }) as never,
    })

    const result = await Effect.runPromise(
      Effect.result(service.mergePullRequest(repository, "branch")),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitHubRequestError)
    }
  })

  it("revalidates after an expected-head GraphQL rejection", async () => {
    let queries = 0
    const requests: unknown[] = []
    const service = makeGitHubService({
      query: (request) => {
        requests.push(request)
        queries += 1
        return Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOOpen",
                  state: "OPEN",
                  merged: false,
                  headRefOid: queries === 1 ? "abc123" : "def456",
                  mergeable: "MERGEABLE",
                  statusCheckRollup: { state: "SUCCESS" },
                },
              ],
            },
          },
        }) as never
      },
      mutation: () =>
        Promise.reject(
          new GenqlError([{ message: "Head branch was modified" }], null),
        ),
    })

    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "branch"),
    )
    expect(result).toMatchObject({
      _tag: "revalidation",
      reason: "head_changed",
    })
    expect(queries).toBe(2)
    expect(requests[1]).toMatchObject({
      repository: {
        pullRequests: {
          __args: { states: ["OPEN", "CLOSED", "MERGED"] },
        },
      },
    })
  })

  it("keeps unrelated GraphQL merge errors operational", async () => {
    let queries = 0
    const service = makeGitHubService({
      query: () => {
        queries += 1
        return Promise.resolve({
          repository: {
            pullRequests: {
              nodes: [
                {
                  id: "PR_kwDOOpen",
                  state: "OPEN",
                  merged: false,
                  headRefOid: "abc123",
                  mergeable: "MERGEABLE",
                  statusCheckRollup: { state: "SUCCESS" },
                },
              ],
            },
          },
        }) as never
      },
      mutation: () =>
        Promise.reject(
          new GenqlError(
            [{ message: "Resource not accessible by personal access token" }],
            null,
          ),
        ),
    })

    const result = await Effect.runPromise(
      Effect.result(service.mergePullRequest(repository, "branch")),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(queries).toBe(1)
  })

  it("keeps malformed mutation rollups operational", async () => {
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
                  mergeable: "MERGEABLE",
                  statusCheckRollup: { state: "SUCCESS" },
                },
              ],
            },
          },
        }) as never,
      mutation: () =>
        Promise.resolve({
          mergePullRequest: {
            pullRequest: {
              state: "OPEN",
              merged: false,
              headRefOid: "abc123",
              mergeable: "MERGEABLE",
              statusCheckRollup: { state: "BROKEN" },
            },
          },
        }) as never,
    })

    const result = await Effect.runPromise(
      Effect.result(service.mergePullRequest(repository, "branch")),
    )
    expect(Result.isFailure(result)).toBe(true)
  })

  it("posts a marked completion summary and closes an open Issue as COMPLETED", async () => {
    const mutations: unknown[] = []
    const workItemId = "wi-01HXSQK2KG72RRYVWEQH4S83FK"
    const summary = "## Findings\n\nNo repository changes were required."
    const service = makeGitHubService({
      query: (request) => {
        const issueSelection = (
          request as {
            repository?: { issue?: { comments?: unknown } }
          }
        ).repository?.issue
        if (issueSelection?.comments !== undefined) {
          return Promise.resolve({
            repository: {
              issue: {
                comments: {
                  nodes: [{ body: "unrelated comment" }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: {
            issue: {
              id: "I_kwDOOpen",
              state: "OPEN",
            },
          },
        }) as never
      },
      mutation: (request) => {
        mutations.push(request)
        if ((request as { addComment?: unknown }).addComment !== undefined) {
          const body = (
            request as {
              addComment: { __args: { input: { body: string } } }
            }
          ).addComment.__args.input.body
          return Promise.resolve({
            addComment: {
              commentEdge: { node: { body } },
            },
          }) as never
        }
        return Promise.resolve({
          closeIssue: {
            issue: { state: "CLOSED" },
          },
        }) as never
      },
    })

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        42,
        workItemId,
        summary,
      ),
    )

    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatchObject({
      addComment: {
        __args: {
          input: {
            subjectId: "I_kwDOOpen",
            body: expect.stringContaining(summary),
          },
        },
      },
    })
    const postedBody = (
      mutations[0] as {
        addComment: { __args: { input: { body: string } } }
      }
    ).addComment.__args.input.body
    expect(postedBody).toContain(
      `<!-- ready-for-agent:work-item:${workItemId} -->`,
    )
    expect(mutations[1]).toMatchObject({
      closeIssue: {
        __args: {
          input: {
            issueId: "I_kwDOOpen",
            stateReason: "COMPLETED",
          },
        },
      },
    })
  })

  it("reuses an existing marked comment without posting a duplicate", async () => {
    const mutations: unknown[] = []
    const workItemId = "wi-01HXSQK2KG72RRYVWEQH4S83FK"
    const marker = `<!-- ready-for-agent:work-item:${workItemId} -->`
    const service = makeGitHubService({
      query: (request) => {
        const issueSelection = (
          request as {
            repository?: { issue?: { comments?: unknown } }
          }
        ).repository?.issue
        if (issueSelection?.comments !== undefined) {
          return Promise.resolve({
            repository: {
              issue: {
                comments: {
                  nodes: [{ body: "noise" }, { body: `## Done\n\n${marker}` }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: {
            issue: {
              id: "I_kwDOOpen",
              state: "OPEN",
            },
          },
        }) as never
      },
      mutation: (request) => {
        mutations.push(request)
        return Promise.resolve({
          closeIssue: {
            issue: { state: "CLOSED" },
          },
        }) as never
      },
    })

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        42,
        workItemId,
        "## Summary",
      ),
    )

    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      closeIssue: {
        __args: {
          input: {
            issueId: "I_kwDOOpen",
            stateReason: "COMPLETED",
          },
        },
      },
    })
  })

  it("finds a marked comment beyond the first comments page", async () => {
    const mutations: unknown[] = []
    const workItemId = "wi-01HXSQK2KG72RRYVWEQH4S83FK"
    const marker = `<!-- ready-for-agent:work-item:${workItemId} -->`
    let commentPages = 0
    const service = makeGitHubService({
      query: (request) => {
        const issueSelection = (
          request as {
            repository?: {
              issue?: {
                comments?: { __args?: { after?: string } }
              }
            }
          }
        ).repository?.issue
        if (issueSelection?.comments !== undefined) {
          commentPages += 1
          const after = issueSelection.comments.__args?.after
          if (after === null || after === undefined) {
            return Promise.resolve({
              repository: {
                issue: {
                  comments: {
                    nodes: [{ body: "page one only" }],
                    pageInfo: { endCursor: "cursor-1", hasNextPage: true },
                  },
                },
              },
            }) as never
          }
          expect(after).toBe("cursor-1")
          return Promise.resolve({
            repository: {
              issue: {
                comments: {
                  nodes: [{ body: `found on page two ${marker}` }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: {
            issue: {
              id: "I_kwDOOpen",
              state: "OPEN",
            },
          },
        }) as never
      },
      mutation: (request) => {
        mutations.push(request)
        return Promise.resolve({
          closeIssue: {
            issue: { state: "CLOSED" },
          },
        }) as never
      },
    })

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        42,
        workItemId,
        "## Summary",
      ),
    )

    expect(commentPages).toBe(2)
    expect(mutations).toHaveLength(1)
    expect(
      (mutations[0] as { addComment?: unknown }).addComment,
    ).toBeUndefined()
  })

  it("succeeds for an already-closed Issue after ensuring the summary", async () => {
    const mutations: unknown[] = []
    const workItemId = "wi-01HXSQK2KG72RRYVWEQH4S83FK"
    const marker = `<!-- ready-for-agent:work-item:${workItemId} -->`
    const service = makeGitHubService({
      query: (request) => {
        const issueSelection = (
          request as {
            repository?: { issue?: { comments?: unknown } }
          }
        ).repository?.issue
        if (issueSelection?.comments !== undefined) {
          return Promise.resolve({
            repository: {
              issue: {
                comments: {
                  nodes: [{ body: `## Already done\n\n${marker}` }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: {
            issue: {
              id: "I_kwDOClosed",
              state: "CLOSED",
            },
          },
        }) as never
      },
      mutation: () => {
        throw new Error("mutation should not run for an already-closed Issue")
      },
    })

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        42,
        workItemId,
        "## Summary",
      ),
    )
    expect(mutations).toHaveLength(0)
  })

  it("posts a missing marked summary on an already-closed Issue without re-closing", async () => {
    const mutations: unknown[] = []
    const workItemId = "wi-01HXSQK2KG72RRYVWEQH4S83FK"
    const service = makeGitHubService({
      query: (request) => {
        const issueSelection = (
          request as {
            repository?: { issue?: { comments?: unknown } }
          }
        ).repository?.issue
        if (issueSelection?.comments !== undefined) {
          return Promise.resolve({
            repository: {
              issue: {
                comments: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: {
            issue: {
              id: "I_kwDOClosed",
              state: "CLOSED",
            },
          },
        }) as never
      },
      mutation: (request) => {
        mutations.push(request)
        const body = (
          request as {
            addComment: { __args: { input: { body: string } } }
          }
        ).addComment.__args.input.body
        return Promise.resolve({
          addComment: {
            commentEdge: { node: { body } },
          },
        }) as never
      },
    })

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        42,
        workItemId,
        "## Late summary",
      ),
    )

    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      addComment: {
        __args: {
          input: {
            subjectId: "I_kwDOClosed",
          },
        },
      },
    })
  })

  it("retries after comment creation without posting a duplicate comment", async () => {
    const workItemId = "wi-01HXSQK2KG72RRYVWEQH4S83FK"
    const marker = `<!-- ready-for-agent:work-item:${workItemId} -->`
    const summary = "## Findings"
    let posted = false
    const mutations: unknown[] = []

    const makeClient = (
      issueState: "OPEN" | "CLOSED",
    ): GitHubGraphqlClient => ({
      query: (request) => {
        const issueSelection = (
          request as {
            repository?: { issue?: { comments?: unknown } }
          }
        ).repository?.issue
        if (issueSelection?.comments !== undefined) {
          return Promise.resolve({
            repository: {
              issue: {
                comments: {
                  nodes: posted
                    ? [{ body: `${summary}\n\n${marker}` }]
                    : [{ body: "unrelated" }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: {
            issue: {
              id: "I_kwDOOpen",
              state: issueState,
            },
          },
        }) as never
      },
      mutation: (request) => {
        mutations.push(request)
        if ((request as { addComment?: unknown }).addComment !== undefined) {
          posted = true
          const body = (
            request as {
              addComment: { __args: { input: { body: string } } }
            }
          ).addComment.__args.input.body
          return Promise.resolve({
            addComment: {
              commentEdge: { node: { body } },
            },
          }) as never
        }
        return Promise.reject(new Error("close failed"))
      },
    })

    const first = makeGitHubService(makeClient("OPEN"))
    await expect(
      Effect.runPromise(
        first.ensureIssueCompletedWithSummary(
          repository,
          42,
          workItemId,
          summary,
        ),
      ),
    ).rejects.toBeInstanceOf(GitHubRequestError)

    expect(mutations).toHaveLength(2)
    expect((mutations[0] as { addComment?: unknown }).addComment).toBeDefined()
    expect((mutations[1] as { closeIssue?: unknown }).closeIssue).toBeDefined()

    mutations.length = 0
    const second = makeGitHubService({
      ...makeClient("OPEN"),
      mutation: (request) => {
        mutations.push(request)
        return Promise.resolve({
          closeIssue: {
            issue: { state: "CLOSED" },
          },
        }) as never
      },
    })

    await Effect.runPromise(
      second.ensureIssueCompletedWithSummary(
        repository,
        42,
        workItemId,
        summary,
      ),
    )

    expect(mutations).toHaveLength(1)
    expect(
      (mutations[0] as { addComment?: unknown }).addComment,
    ).toBeUndefined()
    expect(mutations[0]).toMatchObject({
      closeIssue: {
        __args: {
          input: {
            issueId: "I_kwDOOpen",
            stateReason: "COMPLETED",
          },
        },
      },
    })
  })

  it("maps missing Issue and credential failures for completion", async () => {
    const missing = makeGitHubService({
      query: () =>
        Promise.resolve({
          repository: { issue: null },
        }) as never,
    })
    const missingResult = await Effect.runPromise(
      Effect.result(
        missing.ensureIssueCompletedWithSummary(
          repository,
          99,
          "wi-01HXSQK2KG72RRYVWEQH4S83FK",
          "## Summary",
        ),
      ),
    )
    expect(Result.isFailure(missingResult)).toBe(true)
    if (Result.isFailure(missingResult)) {
      expect(missingResult.failure).toBeInstanceOf(GitHubRequestError)
    }

    const unavailable = makeGitHubService({
      query: () => Promise.resolve({ repository: null }) as never,
    })
    const unavailableResult = await Effect.runPromise(
      Effect.result(
        unavailable.ensureIssueCompletedWithSummary(
          repository,
          99,
          "wi-01HXSQK2KG72RRYVWEQH4S83FK",
          "## Summary",
        ),
      ),
    )
    expect(unavailableResult).toEqual(
      Result.fail(new GitHubRepositoryUnavailableError(repository)),
    )

    let mutationAttempts = 0
    const failingMutation = makeGitHubService({
      query: (request) => {
        const issueSelection = (
          request as {
            repository?: { issue?: { comments?: unknown } }
          }
        ).repository?.issue
        if (issueSelection?.comments !== undefined) {
          return Promise.resolve({
            repository: {
              issue: {
                comments: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }) as never
        }
        return Promise.resolve({
          repository: {
            issue: { id: "I_kwDOOpen", state: "OPEN" },
          },
        }) as never
      },
      mutation: () => {
        mutationAttempts += 1
        return Promise.reject(new Error("token rejected"))
      },
    })
    await expect(
      Effect.runPromise(
        failingMutation.ensureIssueCompletedWithSummary(
          repository,
          42,
          "wi-01HXSQK2KG72RRYVWEQH4S83FK",
          "## Summary",
        ),
      ),
    ).rejects.toBeInstanceOf(GitHubRequestError)
    expect(mutationAttempts).toBe(1)
  })

  it("revalidates a PR whose current head checks are not successful", async () => {
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
      service.mergePullRequest(repository, "branch"),
    )
    expect(result).toMatchObject({
      _tag: "revalidation",
      reason: "checks_not_green",
    })
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
                      isDraft: true,
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
      author: null,
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
      {
        number: 22,
        repository: "acme/widgets",
        state: "OPEN",
        isDraft: true,
        sourceBranch: null,
        sourceRepository: null,
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
    expect(firstRequest.repository.__args).toEqual(apiRepository)
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
      author: {
        login: true,
      },
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
          isDraft: true,
          repository: { nameWithOwner: true },
          headRefName: true,
          headRepository: { nameWithOwner: true },
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
                      isDraft: false,
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
                  isDraft: false,
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
      {
        number: 10,
        repository: "acme/widgets",
        state: "MERGED",
        isDraft: false,
        sourceBranch: null,
        sourceRepository: null,
      },
      {
        number: 20,
        repository: "acme/widgets",
        state: "CLOSED",
        isDraft: false,
        sourceBranch: null,
        sourceRepository: null,
      },
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

  it("maps Issue-closing PR source branch and fork repository identity", async () => {
    const client = {
      query: async () => ({
        repository: {
          issues: {
            nodes: [
              {
                number: 7,
                title: "Has a fork PR",
                body: "Body",
                url: "https://github.com/acme/widgets/issues/7",
                createdAt: "2026-07-07T12:00:00Z",
                state: "OPEN",
                author: { login: "alice" },
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
                      number: 88,
                      state: "OPEN",
                      merged: false,
                      isDraft: false,
                      repository: { nameWithOwner: "acme/widgets" },
                      headRefName: "rfa/acme-widgets/7/wi-1",
                      headRepository: { nameWithOwner: "alice/widgets" },
                    },
                  ],
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
      makeGitHubService(client).listReadyIssues(repository),
    )

    expect(result[0]?.closingPullRequests).toEqual([
      {
        number: 88,
        repository: "acme/widgets",
        state: "OPEN",
        isDraft: false,
        sourceBranch: "rfa/acme-widgets/7/wi-1",
        sourceRepository: "alice/widgets",
      },
    ])
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

describe("user-facing error formatting", () => {
  const esc = String.fromCharCode(0x1b)
  const csiOpen = `${esc}[`

  it("strips ANSI CSI sequences from Effect-style dumps", () => {
    const colored = `{\n  ${esc}[0m_tag${esc}[2m:${esc}[0m ${esc}[32m"GitHubRequestError"${esc}[0m,\n  ${esc}[0mmessage${esc}[2m:${esc}[0m ${esc}[32m"boom happened"${esc}[0m,\n}`
    expect(stripAnsi(colored).includes(csiOpen)).toBe(false)
    expect(sanitizeUserFacingText(colored)).toBe("boom happened")
    expect(formatUserFacingError(colored, "fallback")).toBe("boom happened")
  })

  it("redacts token-shaped secrets from user-facing text", () => {
    const secret = "ghp_this_must_never_appear_in_user_facing_text"
    expect(sanitizeUserFacingText(`auth failed with ${secret}`)).not.toContain(
      secret,
    )
    expect(sanitizeUserFacingText(`auth failed with ${secret}`)).toContain(
      "[redacted]",
    )
  })

  it("prefers Error.message over inspect dumps", () => {
    const error = new GitHubRequestError({
      message: "Failed to get pull request check status for acme/widgets",
    })
    expect(formatUserFacingError(error, "fallback")).toBe(
      "Failed to get pull request check status for acme/widgets",
    )
  })
})

describe("error cause chain", () => {
  it("walks nested causes and surfaces the leaf code", () => {
    const leaf = Object.assign(
      new Error("self-signed certificate in certificate chain"),
      {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      },
    )
    const transport = new TypeError("fetch failed", { cause: leaf })
    const wrapped = new GitHubRequestError({
      message: "Failed to list Ready-labeled Issues for acme/widgets",
      cause: transport,
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    })

    expect(extractErrorCode(wrapped)).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(extractCauseChain(wrapped)).toEqual([
      {
        name: "GitHubRequestError",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
        message: "Failed to list Ready-labeled Issues for acme/widgets",
      },
      {
        name: "TypeError",
        message: "fetch failed",
      },
      {
        name: "Error",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
        message: "self-signed certificate in certificate chain",
      },
    ])

    const annotations = logErrorAnnotations(wrapped)
    expect(annotations.error).toBe(
      "Failed to list Ready-labeled Issues for acme/widgets",
    )
    expect(annotations.code).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(annotations.causeChain).toHaveLength(3)

    const detail = buildReasonDetail(wrapped)
    expect(detail).not.toBeNull()
    expect(detail?.code).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(JSON.parse(serializeReasonDetail(detail)!)).toEqual(detail)
  })

  it("returns an empty chain for uninformative values", () => {
    expect(extractCauseChain(null)).toEqual([])
    expect(extractCauseChain(undefined)).toEqual([])
    expect(extractErrorCode({})).toBeUndefined()
    expect(buildReasonDetail(null)).toBeNull()
  })

  it("maps Effect TimeoutError to code TIMEOUT", () => {
    const timeout = Object.assign(new Error(), {
      name: "TimeoutError",
      _tag: "TimeoutError",
    })
    expect(extractErrorCode(timeout)).toBe("TIMEOUT")
    expect(extractCauseChain(timeout)).toEqual([
      { name: "TimeoutError", code: "TIMEOUT" },
    ])
  })

  it("derives a cause-chain code from exitCode when code is absent", () => {
    const exitFailure = Object.assign(new Error("model overloaded"), {
      name: "AgentBackendExitError",
      _tag: "AgentBackendExitError",
      exitCode: 1,
    })
    expect(extractErrorCode(exitFailure)).toBe("1")
    expect(extractCauseChain(exitFailure)).toEqual([
      {
        name: "AgentBackendExitError",
        code: "1",
        message: "model overloaded",
      },
    ])
  })

  it("parses a persisted reason_detail blob into the typed cause chain", () => {
    const detail = {
      causeChain: [
        {
          name: "GitHubRequestError",
          code: "SELF_SIGNED_CERT_IN_CHAIN",
          message: "Failed to list Ready-labeled Issues for acme/widgets",
        },
        {
          name: "Error",
          code: "SELF_SIGNED_CERT_IN_CHAIN",
          message: "self-signed certificate in certificate chain",
        },
      ],
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    }

    expect(parseReasonDetail(JSON.stringify(detail))).toEqual(detail)
  })

  it("returns null for missing, empty, or unparseable reason_detail", () => {
    expect(parseReasonDetail(null)).toBeNull()
    expect(parseReasonDetail(undefined)).toBeNull()
    expect(parseReasonDetail("")).toBeNull()
    expect(parseReasonDetail("   ")).toBeNull()
    expect(parseReasonDetail("not-json")).toBeNull()
    expect(parseReasonDetail("[]")).toBeNull()
    expect(parseReasonDetail(JSON.stringify({}))).toBeNull()
  })

  it("re-sanitizes stored link messages on parse", () => {
    const esc = String.fromCharCode(0x1b)
    const parsed = parseReasonDetail(
      JSON.stringify({
        causeChain: [
          {
            name: "Error",
            code: "ENOENT",
            message: `${esc}[31mENOENT: Executable not found in $PATH: "claude"${esc}[0m`,
          },
        ],
        code: "ENOENT",
      }),
    )

    expect(parsed).toEqual({
      causeChain: [
        {
          name: "Error",
          code: "ENOENT",
          message: 'ENOENT: Executable not found in $PATH: "claude"',
        },
      ],
      code: "ENOENT",
    })
  })
})

describe("CLI arguments", () => {
  it.effect("reports a missing argument as a typed failure", () =>
    Effect.gen(function* () {
      const error = yield* decodeArgument(undefined, "forge").pipe(Effect.flip)
      expect(error._tag).toBe("CliArgumentError")
      expect(error.message).toBe("Missing forge argument")
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
    expect(result.stderr).toContain("Missing forge argument")
    expect(result.stderr.includes(`${String.fromCharCode(0x1b)}[`)).toBe(false)
    expect(result.stderr).not.toMatch(/_tag/)
  })
})

describe("GitHubService identity and Issue Author", () => {
  it("returns the authenticated viewer login", async () => {
    const client = {
      query: async () => ({
        viewer: { login: "OctoCat" },
      }),
    } as GitHubGraphqlClient

    const login = await Effect.runPromise(
      makeGitHubService(client).getAuthenticatedUserLogin(repository),
    )

    expect(login).toBe("OctoCat")
  })

  it("maps Issue Author login and null/ghost authors", async () => {
    const client = {
      query: async () => ({
        repository: {
          issues: {
            nodes: [
              {
                number: 1,
                title: "Mine",
                body: "body",
                url: "https://github.com/acme/widgets/issues/1",
                createdAt: "2026-07-01T12:00:00Z",
                state: "OPEN",
                author: { login: "octocat" },
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
              {
                number: 2,
                title: "Ghost",
                body: "body",
                url: "https://github.com/acme/widgets/issues/2",
                createdAt: "2026-07-02T12:00:00Z",
                state: "OPEN",
                author: null,
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
      makeGitHubService(client).listReadyIssues(repository),
    )

    expect(result.map(({ number, author }) => ({ number, author }))).toEqual([
      { number: 1, author: "octocat" },
      { number: 2, author: null },
    ])
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
        return yield* github.listReadyIssues({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "ACME/Widgets",
        })
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
