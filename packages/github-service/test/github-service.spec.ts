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
  formatUserFacingError,
  makeGitHubServiceFromToken,
  makeGitHubServiceTest,
  sanitizeUserFacingText,
  stripAnsi,
} from "../src/index.js"
import { GenqlError } from "../src/internal/generated/runtime/error.js"
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
  author: null,
  parent: null,
  parentPosition: null,
  hasChildren: false,
  hierarchySupported: true,
  blockedBy: [],
  closingPullRequests: [],
})

describe("GitHubService live implementation", () => {
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
        headPushedAt: null,
        headSha: "abc123",
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
    })
  })

  it("reads the current head commit pushedDate as headPushedAt", async () => {
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
    })
    expect(request).toMatchObject({
      repository: {
        pullRequests: {
          nodes: {
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
      terminalChecks: [
        { externalId: "actions-job:200", name: "CI/lint", outcome: "red" },
      ],
    })
  })

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
  ] as const)("returns a revalidation outcome for %s", async (_description, mergeable, checkState, reason) => {
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
  })

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
  ] as const)("classifies %s returned by the merge mutation", async (_description, pullRequest, tag, reason) => {
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
  })

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
      },
      {
        number: 20,
        repository: "acme/widgets",
        state: "CLOSED",
        isDraft: false,
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

  it("prefers Error.message over inspect dumps", () => {
    const error = new GitHubRequestError({
      message: "Failed to get pull request check status for acme/widgets",
    })
    expect(formatUserFacingError(error, "fallback")).toBe(
      "Failed to get pull request check status for acme/widgets",
    )
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
