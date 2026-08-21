import { Effect, Result } from "effect"
import {
  AzureDevOpsNotImplementedError,
  AzureDevOpsProjectUnavailableError,
  AzureDevOpsRequestError,
  makeAzureDevOpsServiceFromToken,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const repository = {
  forge: "azure-devops",
  forgeHost: "dev.azure.com",
  projectPath: "acme/widgets",
}

const json = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })

const fakeFetch = (
  responses: Readonly<Record<string, unknown | Response>>,
): typeof fetch =>
  (async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const pathKey = `${url.pathname}${url.search}`
    const response = responses[`${method} ${pathKey}`] ?? responses[pathKey]
    if (response === undefined) {
      throw new Error(`Unexpected request: ${method} ${pathKey}`)
    }
    return response instanceof Response ? response : json(response)
  }) as typeof fetch

describe("Azure DevOps verifyProject", () => {
  test("verifies a project and canonicalizes the returned casing", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/projects/widgets?api-version=7.1": {
          id: "11111111-1111-1111-1111-111111111111",
          name: "Widgets",
        },
      }),
    )

    await expect(
      Effect.runPromise(service.verifyProject(repository)),
    ).resolves.toEqual({
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/Widgets",
    })
  })

  test("sends the PAT as HTTP Basic auth with an empty username", async () => {
    let authorization: string | null = null
    const service = makeAzureDevOpsServiceFromToken("s3cr3t", (async (
      _input,
      init,
    ) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      authorization = headers.Authorization ?? null
      return json({ name: "widgets" })
    }) as typeof fetch)
    await Effect.runPromise(service.verifyProject(repository))
    expect(authorization).toBe(
      `Basic ${Buffer.from(":s3cr3t").toString("base64")}`,
    )
  })

  test("rejects an unknown project as project-unavailable", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/projects/widgets?api-version=7.1": new Response(
          "not found",
          { status: 404 },
        ),
      }),
    )
    const result = await Effect.runPromise(
      service.verifyProject(repository).pipe(Effect.result),
    )
    expect(result).toEqual(
      Result.fail(new AzureDevOpsProjectUnavailableError(repository)),
    )
  })

  test("rejects a malformed Project Path before making a request", async () => {
    const service = makeAzureDevOpsServiceFromToken("test-pat", (() => {
      throw new Error("must not fetch for an invalid Project Path")
    }) as unknown as typeof fetch)
    const error = await Effect.runPromise(
      service
        .verifyProject({
          ...repository,
          projectPath: "acme/widgets/extra/toomany",
        })
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
  })

  test("canonicalizes project casing while preserving an explicit repository segment", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/projects/Default?api-version=7.1": {
          id: "11111111-1111-1111-1111-111111111111",
          name: "Default",
        },
      }),
    )

    await expect(
      Effect.runPromise(
        service.verifyProject({
          ...repository,
          projectPath: "acme/Default/gantry",
        }),
      ),
    ).resolves.toEqual({
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/Default/gantry",
    })
  })
})

describe("Azure DevOps getAuthenticatedUserLogin", () => {
  test("resolves the Operator Forge User through the token", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/connectionData?api-version=7.1-preview": {
          authenticatedUser: {
            id: "user-id",
            providerDisplayName: "Jane Operator",
          },
        },
      }),
    )
    await expect(
      Effect.runPromise(service.getAuthenticatedUserLogin(repository)),
    ).resolves.toBe("Jane Operator")
  })

  test("prefers customDisplayName over the Entra directory providerDisplayName", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/connectionData?api-version=7.1-preview": {
          authenticatedUser: {
            id: "user-id",
            // Real Azure DevOps accounts can report a different Entra/AAD
            // directory name than their ADO-native customDisplayName — the
            // latter is what matches System.CreatedBy.displayName on work
            // items authored by this account, so it must win.
            providerDisplayName: "Christopher Barlow",
            customDisplayName: "Chris Barlow",
          },
        },
      }),
    )
    await expect(
      Effect.runPromise(service.getAuthenticatedUserLogin(repository)),
    ).resolves.toBe("Chris Barlow")
  })

  test("falls back to the authenticated user id when display name is absent", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/connectionData?api-version=7.1-preview": {
          authenticatedUser: { id: "user-id" },
        },
      }),
    )
    await expect(
      Effect.runPromise(service.getAuthenticatedUserLogin(repository)),
    ).resolves.toBe("user-id")
  })

  test("preserves authentication status on request failures", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "expired",
      fakeFetch({
        "/acme/_apis/connectionData?api-version=7.1-preview": new Response(
          "unauthorized",
          { status: 401 },
        ),
      }),
    )
    const error = await Effect.runPromise(
      service.getAuthenticatedUserLogin(repository).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
    expect(error.statusCode).toBe(401)
  })
})

describe("Azure DevOps hasCredentials / hasAmbientCredentials", () => {
  test("reports credentials only when a token is configured", async () => {
    const withToken = makeAzureDevOpsServiceFromToken("test-pat", fetch)
    const withoutToken = makeAzureDevOpsServiceFromToken("", fetch)

    await expect(
      Effect.runPromise(withToken.hasCredentials(repository)),
    ).resolves.toBe(true)
    await expect(
      Effect.runPromise(withToken.hasAmbientCredentials(repository)),
    ).resolves.toBe(true)

    // Empty string is still "configured" for makeAzureDevOpsServiceFromToken
    // (a token argument was supplied); the meaningful case for callers is the
    // Live layer, which only builds a service when the env var resolves.
    await expect(
      Effect.runPromise(withoutToken.hasCredentials(repository)),
    ).resolves.toBe(true)
  })
})

describe("Azure DevOps listReadyIssues", () => {
  const wiqlPath = "POST /acme/widgets/_apis/wit/wiql?api-version=7.1"
  const batchPath = (ids: string): string =>
    `/acme/_apis/wit/workitems?ids=${ids}&$expand=all&errorPolicy=Omit&api-version=7.1`

  test("lists Ready-labeled work items and populates open Predecessor blockers", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [wiqlPath]: { workItems: [{ id: 10 }, { id: 11 }] },
        [batchPath("10,11")]: {
          value: [
            {
              id: 10,
              fields: {
                "System.Title": "First",
                "System.Description": "Body 1",
                "System.State": "Active",
                "System.CreatedDate": "2026-01-01T00:00:00Z",
                "System.CreatedBy": { displayName: "Jane Operator" },
              },
              relations: [
                {
                  rel: "System.LinkTypes.Dependency-Reverse",
                  url: "https://dev.azure.com/acme/_apis/wit/workItems/5",
                },
                {
                  rel: "System.LinkTypes.Hierarchy-Forward",
                  url: "https://dev.azure.com/acme/_apis/wit/workItems/99",
                },
              ],
            },
            {
              id: 11,
              fields: {
                "System.Title": "Second",
                "System.State": "New",
                "System.CreatedDate": "2026-01-02T00:00:00Z",
              },
            },
          ],
        },
        [batchPath("5")]: {
          value: [{ id: 5, fields: { "System.State": "Active" } }],
        },
      }),
    )

    const issues = await Effect.runPromise(service.listReadyIssues(repository))

    expect(issues).toEqual([
      {
        number: 10,
        title: "First",
        body: "Body 1",
        url: "https://dev.azure.com/acme/widgets/_workitems/edit/10",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        state: "OPEN",
        author: "Jane Operator",
        parent: null,
        parentPosition: null,
        hasChildren: false,
        hierarchySupported: false,
        blockedBy: [
          {
            number: 5,
            url: "https://dev.azure.com/acme/widgets/_workitems/edit/5",
          },
        ],
        closingPullRequests: [],
      },
      {
        number: 11,
        title: "Second",
        body: "",
        url: "https://dev.azure.com/acme/widgets/_workitems/edit/11",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        state: "OPEN",
        author: null,
        parent: null,
        parentPosition: null,
        hasChildren: false,
        hierarchySupported: false,
        blockedBy: [],
        closingPullRequests: [],
      },
    ])
  })

  test("excludes a Ready-tagged work item once it is itself closed", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [wiqlPath]: { workItems: [{ id: 10 }, { id: 11 }] },
        [batchPath("10,11")]: {
          value: [
            {
              id: 10,
              fields: {
                "System.Title": "Still open",
                "System.State": "Active",
                "System.CreatedDate": "2026-01-01T00:00:00Z",
              },
            },
            {
              id: 11,
              fields: {
                "System.Title": "Already closed",
                "System.State": "Closed",
                "System.CreatedDate": "2026-01-02T00:00:00Z",
              },
            },
          ],
        },
      }),
    )

    const issues = await Effect.runPromise(service.listReadyIssues(repository))
    expect(issues.map((issue) => issue.number)).toEqual([10])
  })

  test("excludes a Predecessor blocker once its work item is closed", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [wiqlPath]: { workItems: [{ id: 10 }] },
        [batchPath("10")]: {
          value: [
            {
              id: 10,
              fields: {
                "System.Title": "First",
                "System.State": "Active",
                "System.CreatedDate": "2026-01-01T00:00:00Z",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Dependency-Reverse",
                  url: "https://dev.azure.com/acme/_apis/wit/workItems/5",
                },
              ],
            },
          ],
        },
        [batchPath("5")]: {
          value: [{ id: 5, fields: { "System.State": "Closed" } }],
        },
      }),
    )

    const issues = await Effect.runPromise(service.listReadyIssues(repository))
    expect(issues[0]?.blockedBy).toEqual([])
  })

  test("never blocked by the Successor (forward) end of a dependency link", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [wiqlPath]: { workItems: [{ id: 10 }] },
        [batchPath("10")]: {
          value: [
            {
              id: 10,
              fields: {
                "System.Title": "First",
                "System.State": "Active",
                "System.CreatedDate": "2026-01-01T00:00:00Z",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Dependency-Forward",
                  url: "https://dev.azure.com/acme/_apis/wit/workItems/7",
                },
              ],
            },
          ],
        },
      }),
    )

    const issues = await Effect.runPromise(service.listReadyIssues(repository))
    expect(issues[0]?.blockedBy).toEqual([])
  })

  test("returns an empty list when no work item is tagged ready-for-agent", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({ [wiqlPath]: { workItems: [] } }),
    )
    await expect(
      Effect.runPromise(service.listReadyIssues(repository)),
    ).resolves.toEqual([])
  })

  test("sends the WIQL query scoped to System.Tags", async () => {
    let requestBody: unknown
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/wiql")) {
        requestBody =
          init?.body === undefined ? undefined : JSON.parse(String(init.body))
        return json({ workItems: [] })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch)
    await Effect.runPromise(service.listReadyIssues(repository))
    expect(requestBody).toEqual({
      query:
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS 'ready-for-agent' ORDER BY [System.Id]",
    })
  })

  test("rejects an unavailable project as project-unavailable", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [wiqlPath]: new Response("not found", { status: 404 }),
      }),
    )
    const result = await Effect.runPromise(
      service.listReadyIssues(repository).pipe(Effect.result),
    )
    expect(result).toEqual(
      Result.fail(new AzureDevOpsProjectUnavailableError(repository)),
    )
  })
})

describe("Azure DevOps not-yet-implemented methods", () => {
  test("every remaining method fails with AzureDevOpsNotImplementedError", async () => {
    const service = makeAzureDevOpsServiceFromToken("test-pat", fetch)
    const cases: ReadonlyArray<{
      readonly method: string
      readonly run: () => Effect.Effect<unknown, unknown>
    }> = [
      {
        method: "countOpenNonDraftPullRequests",
        run: () => service.countOpenNonDraftPullRequests(repository),
      },
    ]
    expect(cases).toHaveLength(1)
    for (const { method, run } of cases) {
      const error = await Effect.runPromise(run().pipe(Effect.flip))
      expect(error).toBeInstanceOf(AzureDevOpsNotImplementedError)
      if (error instanceof AzureDevOpsNotImplementedError) {
        expect(error.method).toBe(method)
      }
    }
  })
})

const activePullRequestListPath =
  "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1"
const allPullRequestListPath =
  "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=all&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1"

describe("Azure DevOps getPullRequestCheckStatus", () => {
  test("reports pending when no pull request is yet visible for the branch", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: { value: [] },
        [allPullRequestListPath]: { value: [] },
      }),
    )
    await expect(
      Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "feature"),
      ),
    ).resolves.toEqual({
      _tag: "pending",
      terminalChecks: [],
      mergeability: "unknown",
      baseRefName: null,
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    })
  })

  test("maps non-conflict mergeStatus values (failure, rejectedByPolicy, queued, notSet) to unknown", async () => {
    for (const mergeStatus of [
      "failure",
      "rejectedByPolicy",
      "queued",
      "notSet",
    ]) {
      const service = makeAzureDevOpsServiceFromToken(
        "test-pat",
        fakeFetch({
          [activePullRequestListPath]: {
            value: [
              {
                pullRequestId: 42,
                status: "active",
                isDraft: false,
                mergeStatus,
                lastMergeSourceCommit: { commitId: "abc123" },
                repository: { project: { id: "proj-1" } },
              },
            ],
          },
          "/acme/widgets/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-1%2F42&api-version=7.1-preview":
            { value: [] },
          "/acme/widgets/_apis/git/repositories/widgets/pullrequests/42/statuses?api-version=7.1":
            { value: [] },
          "/acme/widgets/_apis/git/repositories/widgets/commits/abc123?api-version=7.1":
            new Response("not found", { status: 404 }),
        }),
      )
      const status = await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "feature"),
      )
      expect(status.mergeability).toBe("unknown")
    }
  })

  test("maps mergeStatus conflicts to conflicting mergeability", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [
            {
              pullRequestId: 42,
              status: "active",
              isDraft: false,
              mergeStatus: "conflicts",
              lastMergeSourceCommit: { commitId: "abc123" },
              repository: { project: { id: "proj-1" } },
            },
          ],
        },
        "/acme/widgets/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-1%2F42&api-version=7.1-preview":
          { value: [] },
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests/42/statuses?api-version=7.1":
          { value: [] },
        "/acme/widgets/_apis/git/repositories/widgets/commits/abc123?api-version=7.1":
          new Response("not found", { status: 404 }),
      }),
    )
    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "feature"),
    )
    expect(status.mergeability).toBe("conflicting")
  })

  test("aggregates a red policy evaluation and a red status as failed", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [
            {
              pullRequestId: 42,
              status: "active",
              isDraft: false,
              targetRefName: "refs/heads/main",
              mergeStatus: "succeeded",
              lastMergeSourceCommit: { commitId: "abc123" },
              creationDate: "2026-01-01T00:00:00Z",
              repository: { project: { id: "proj-1" } },
            },
          ],
        },
        "/acme/widgets/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-1%2F42&api-version=7.1-preview":
          {
            value: [
              {
                evaluationId: "eval-1",
                status: "rejected",
                configuration: { type: { displayName: "Build validation" } },
              },
            ],
          },
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests/42/statuses?api-version=7.1":
          {
            value: [
              {
                id: 7,
                state: "failed",
                context: { name: "lint", genre: "ci" },
              },
            ],
          },
        "/acme/widgets/_apis/git/repositories/widgets/commits/abc123?api-version=7.1":
          { committer: { date: "2026-01-02T00:00:00Z" } },
      }),
    )
    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "feature"),
    )
    expect(status._tag).toBe("failed")
    expect(status.mergeability).toBe("mergeable")
    expect(status.headSha).toBe("abc123")
    expect(status.baseRefName).toBe("main")
    if (status._tag === "failed") {
      expect(status.terminalChecks).toEqual([
        {
          externalId: "azure-policy:eval-1",
          name: "Build validation",
          outcome: "red",
        },
        { externalId: "azure-status:7", name: "ci/lint", outcome: "red" },
      ])
    }
  })

  test("fails closed when the policy evaluations endpoint errors (ADR 0061 fail-safe)", async () => {
    // A policy-endpoint failure (including a 404, which may mean the
    // unverified artifactId format is wrong) must surface as an error —
    // never fold into "no checks", which a green status or acceptNoChecks
    // could then merge on.
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [
            {
              pullRequestId: 42,
              status: "active",
              isDraft: false,
              mergeStatus: "succeeded",
              lastMergeSourceCommit: { commitId: "abc123" },
              repository: { project: { id: "proj-1" } },
            },
          ],
        },
        "/acme/widgets/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-1%2F42&api-version=7.1-preview":
          new Response("not found", { status: 404 }),
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests/42/statuses?api-version=7.1":
          {
            value: [{ id: 7, state: "succeeded", context: { name: "ci" } }],
          },
      }),
    )
    const result = await Effect.runPromise(
      service
        .getPullRequestCheckStatus(repository, "feature")
        .pipe(Effect.result),
    )
    if (!Result.isFailure(result)) {
      throw new Error("expected the check status observation to fail")
    }
    expect(result.failure).toBeInstanceOf(AzureDevOpsRequestError)
    expect(result.failure.message).toContain("policy evaluations")
  })

  test("fails closed when the pull request response omits the project GUID", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [
            {
              pullRequestId: 42,
              status: "active",
              isDraft: false,
              mergeStatus: "succeeded",
              lastMergeSourceCommit: { commitId: "abc123" },
            },
          ],
        },
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests/42/statuses?api-version=7.1":
          {
            value: [{ id: 7, state: "succeeded", context: { name: "ci" } }],
          },
      }),
    )
    const result = await Effect.runPromise(
      service
        .getPullRequestCheckStatus(repository, "feature")
        .pipe(Effect.result),
    )
    if (!Result.isFailure(result)) {
      throw new Error("expected the check status observation to fail")
    }
    expect(result.failure).toBeInstanceOf(AzureDevOpsRequestError)
    expect(result.failure.message).toContain("cannot be observed")
  })

  test("reports succeeded and forces mergeable when the pull request is completed", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [
            {
              pullRequestId: 42,
              status: "completed",
              isDraft: false,
              mergeStatus: "conflicts",
              lastMergeSourceCommit: { commitId: "abc123" },
            },
          ],
        },
        "/acme/widgets/_apis/git/repositories/widgets/commits/abc123?api-version=7.1":
          new Response("not found", { status: 404 }),
      }),
    )
    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "feature"),
    )
    expect(status._tag).toBe("succeeded")
    expect(status.mergeability).toBe("mergeable")
  })

  test("reports closed when the pull request was abandoned", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [{ pullRequestId: 42, status: "abandoned", isDraft: false }],
        },
      }),
    )
    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "feature"),
    )
    expect(status._tag).toBe("closed")
  })
})

describe("Azure DevOps getPrStatusCheckDiagnostics", () => {
  test("loads a build log excerpt for a red policy evaluation", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/policy/evaluations/eval-1?api-version=7.1-preview":
          {
            evaluationId: "eval-1",
            status: "rejected",
            context: { buildId: 99 },
          },
        "/acme/widgets/_apis/build/builds/99/logs?api-version=7.1": {
          value: [{ id: 1 }, { id: 2 }],
        },
        "/acme/widgets/_apis/build/builds/99/logs/2?api-version=7.1":
          new Response("line one\nline two", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      }),
    )
    const diagnostics = await Effect.runPromise(
      service.getPrStatusCheckDiagnostics(repository, [
        { externalId: "azure-policy:eval-1", name: "Build validation" },
      ]),
    )
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.source).toBe("azure-policy")
    expect(diagnostics[0]?.htmlUrl).toBe(
      "https://dev.azure.com/acme/widgets/_build/results?buildId=99",
    )
    expect(diagnostics[0]?.logFetch).toEqual({
      _tag: "ok",
      excerpt: "line one\nline two",
      localPath: null,
    })
  })

  test("reports unavailable for an azure-status check (no log content)", async () => {
    const service = makeAzureDevOpsServiceFromToken("test-pat", fetch)
    const diagnostics = await Effect.runPromise(
      service.getPrStatusCheckDiagnostics(repository, [
        { externalId: "azure-status:7", name: "ci/lint" },
      ]),
    )
    expect(diagnostics).toEqual([
      {
        externalId: "azure-status:7",
        name: "ci/lint",
        source: "azure-status",
        htmlUrl: null,
        logFetch: {
          _tag: "unavailable",
          reason:
            "Azure DevOps does not expose log content for pull request statuses",
        },
      },
    ])
  })
})

describe("Azure DevOps getPullRequestLifecycleStatus", () => {
  test("reports not_found when no pull request exists", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: { value: [] },
        [allPullRequestListPath]: { value: [] },
      }),
    )
    await expect(
      Effect.runPromise(
        service.getPullRequestLifecycleStatus(repository, "feature"),
      ),
    ).resolves.toEqual({ _tag: "not_found" })
  })

  test("reports merged, closed, and open", async () => {
    for (const [status, expected] of [
      ["completed", "merged"],
      ["abandoned", "closed"],
      ["active", "open"],
    ] as const) {
      const service = makeAzureDevOpsServiceFromToken(
        "test-pat",
        fakeFetch({
          [activePullRequestListPath]: {
            value: [{ pullRequestId: 1, status, isDraft: false }],
          },
        }),
      )
      await expect(
        Effect.runPromise(
          service.getPullRequestLifecycleStatus(repository, "feature"),
        ),
      ).resolves.toEqual({ _tag: expected })
    }
  })
})

describe("Azure DevOps mergePullRequest", () => {
  test("merges a ready pull request", async () => {
    let patchBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "PATCH") {
        patchBody = JSON.parse(String(init?.body))
        return json({ pullRequestId: 42, status: "completed" })
      }
      if (url.pathname.endsWith("/statuses")) {
        return json({ value: [] })
      }
      if (url.pathname.includes("/policy/evaluations")) {
        return json({ value: [{ evaluationId: "e1", status: "approved" }] })
      }
      return json({
        value: [
          {
            pullRequestId: 42,
            status: "active",
            isDraft: false,
            mergeStatus: "succeeded",
            lastMergeSourceCommit: { commitId: "sha-1" },
            repository: { project: { id: "proj-1" } },
          },
        ],
      })
    }) as unknown as typeof fetch)

    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "feature"),
    )
    expect(result).toEqual({ _tag: "merged" })
    expect(patchBody).toEqual({
      status: "completed",
      lastMergeSourceCommit: { commitId: "sha-1" },
      completionOptions: { transitionWorkItems: true },
    })
  })

  test("re-fetches and reclassifies after a 422 merge precondition rejection", async () => {
    let patchAttempts = 0
    let pullRequestListCalls = 0
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "PATCH") {
        patchAttempts += 1
        return new Response("policy not yet satisfied", { status: 422 })
      }
      if (url.pathname.endsWith("/statuses")) {
        return json({ value: [] })
      }
      if (url.pathname.includes("/policy/evaluations")) {
        return json({ value: [{ evaluationId: "e1", status: "approved" }] })
      }
      pullRequestListCalls += 1
      // First classify sees an active, ready-to-merge PR; the post-422
      // re-fetch sees it already completed (merged concurrently elsewhere
      // while the policy precondition was being resolved).
      const status = pullRequestListCalls === 1 ? "active" : "completed"
      return json({
        value: [
          {
            pullRequestId: 42,
            status,
            isDraft: false,
            mergeStatus: "succeeded",
            lastMergeSourceCommit: { commitId: "sha-1" },
            repository: { project: { id: "proj-1" } },
          },
        ],
      })
    }) as unknown as typeof fetch)

    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "feature"),
    )
    expect(result).toEqual({ _tag: "merged" })
    expect(patchAttempts).toBe(1)
    expect(pullRequestListCalls).toBe(2)
  })

  test("reports needs_human missing_successful_checks with no green checks", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [
            {
              pullRequestId: 42,
              status: "active",
              isDraft: false,
              mergeStatus: "succeeded",
              lastMergeSourceCommit: { commitId: "sha-1" },
              repository: { project: { id: "proj-1" } },
            },
          ],
        },
        "/acme/widgets/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-1%2F42&api-version=7.1-preview":
          { value: [] },
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests/42/statuses?api-version=7.1":
          { value: [] },
      }),
    )
    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "feature"),
    )
    expect(result).toEqual({
      _tag: "needs_human",
      reason: "missing_successful_checks",
      message:
        "No successful build validation / branch policy checks were reported for acme/widgets:feature",
    })
  })

  test("reports needs_human closed_unmerged when the pull request was abandoned", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: {
          value: [{ pullRequestId: 42, status: "abandoned", isDraft: false }],
        },
      }),
    )
    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "feature"),
    )
    expect(result).toEqual({
      _tag: "needs_human",
      reason: "closed_unmerged",
      message:
        "Pull request for acme/widgets:feature was closed without merging",
    })
  })

  test("fails when no pull request exists for the branch", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        [activePullRequestListPath]: { value: [] },
        [allPullRequestListPath]: { value: [] },
      }),
    )
    const error = await Effect.runPromise(
      service.mergePullRequest(repository, "feature").pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
  })
})

describe("Azure DevOps ensureIssueCompletedWithSummary", () => {
  test("posts a marked summary comment and closes the work item", async () => {
    let postedComment: unknown = null
    let patchBody: unknown = null
    const commentApiVersions: string[] = []
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (url.pathname.endsWith("/comments")) {
        commentApiVersions.push(url.searchParams.get("api-version") ?? "")
        if (method === "POST") {
          postedComment = JSON.parse(String(init?.body))
          return json({ text: (postedComment as { text: string }).text })
        }
        return json({ comments: [] })
      }
      if (url.pathname.endsWith("/states")) {
        return json({
          value: [
            { name: "Active", category: "InProgress" },
            { name: "Closed", category: "Completed" },
          ],
        })
      }
      if (method === "PATCH") {
        patchBody = JSON.parse(String(init?.body))
        return json({
          id: 1,
          fields: { "System.State": "Closed" },
        })
      }
      return json({
        id: 1,
        fields: { "System.State": "Active", "System.WorkItemType": "Task" },
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        1,
        "wi-1",
        "All done",
      ),
    )
    expect(postedComment).toEqual({
      text: "All done\n\n<!-- ready-for-agent:work-item:wi-1 -->",
    })
    expect(patchBody).toEqual([
      { op: "add", path: "/fields/System.State", value: "Closed" },
    ])
    // The comments surface is preview-only on this API; the GA "7.1" version
    // has no comments endpoint.
    expect(commentApiVersions).toEqual(["7.1-preview.3", "7.1-preview.3"])
  })

  test("falls back to the literal Closed state when the type-states lookup fails", async () => {
    let patchBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (url.pathname.endsWith("/comments")) {
        if (method === "POST") {
          const posted = JSON.parse(String(init?.body)) as { text: string }
          return json({ text: posted.text })
        }
        return json({ comments: [] })
      }
      if (url.pathname.endsWith("/states")) {
        return new Response("not found", { status: 404 })
      }
      if (method === "PATCH") {
        patchBody = JSON.parse(String(init?.body))
        return json({
          id: 1,
          fields: { "System.State": "Closed" },
        })
      }
      return json({
        id: 1,
        fields: { "System.State": "Active", "System.WorkItemType": "Task" },
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        1,
        "wi-1",
        "All done",
      ),
    )
    expect(patchBody).toEqual([
      { op: "add", path: "/fields/System.State", value: "Closed" },
    ])
  })

  test("falls back to the literal Closed state when the type-states response fails to decode", async () => {
    let patchBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (url.pathname.endsWith("/comments")) {
        if (method === "POST") {
          const posted = JSON.parse(String(init?.body)) as { text: string }
          return json({ text: posted.text })
        }
        return json({ comments: [] })
      }
      if (url.pathname.endsWith("/states")) {
        // Schema-invalid body (missing the required "value" array): must not
        // crash the close-out as an unhandled defect; falls back like a 404.
        return json({ notValue: [] })
      }
      if (method === "PATCH") {
        patchBody = JSON.parse(String(init?.body))
        return json({
          id: 1,
          fields: { "System.State": "Closed" },
        })
      }
      return json({
        id: 1,
        fields: { "System.State": "Active", "System.WorkItemType": "Task" },
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        1,
        "wi-1",
        "All done",
      ),
    )
    expect(patchBody).toEqual([
      { op: "add", path: "/fields/System.State", value: "Closed" },
    ])
  })

  test("fails a schema-invalid Work Item body in the typed error channel, not a defect", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      // Schema-invalid Work Item body (missing the required fields map):
      // must surface as an AzureDevOpsRequestError failure so callers'
      // mapError can handle it, never an unhandled thrown defect.
      (() => json({ id: 1 })) as unknown as typeof fetch,
    )

    const result = await Effect.runPromise(
      service
        .ensureIssueCompletedWithSummary(repository, 1, "wi-1", "All done")
        .pipe(Effect.result),
    )
    if (!Result.isFailure(result)) {
      throw new Error("expected the close-out to fail")
    }
    expect(result.failure).toBeInstanceOf(AzureDevOpsRequestError)
    expect(result.failure.message).toBe(
      "Azure DevOps returned an invalid Work Item for acme/widgets#1",
    )
  })

  test("does not repost when a marked comment already exists", async () => {
    let posted = false
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (url.pathname.endsWith("/comments") && method === "POST") {
        posted = true
        return json({})
      }
      if (url.pathname.endsWith("/comments")) {
        return json({
          comments: [
            { text: "All done\n\n<!-- ready-for-agent:work-item:wi-1 -->" },
          ],
        })
      }
      return json({
        id: 1,
        fields: { "System.State": "Closed" },
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        1,
        "wi-1",
        "All done",
      ),
    )
    expect(posted).toBe(false)
  })
})

describe("Azure DevOps closeOpenPullRequestsForBranch", () => {
  test("abandons every active pull request for the branch", async () => {
    const patched: number[] = []
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "PATCH") {
        const match = /\/pullrequests\/(\d+)/.exec(url.pathname)
        patched.push(Number(match?.[1]))
        return json({ pullRequestId: Number(match?.[1]), status: "abandoned" })
      }
      return json({
        value: [
          { pullRequestId: 1, status: "active", isDraft: false },
          { pullRequestId: 2, status: "active", isDraft: false },
        ],
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.closeOpenPullRequestsForBranch(repository, "feature"),
    )
    expect(patched.sort()).toEqual([1, 2])
  })
})

describe("Azure DevOps deleteBranch", () => {
  test("deletes the ref by posting the zero object id", async () => {
    let postedBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      _input,
      init,
    ) => {
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "POST") {
        postedBody = JSON.parse(String(init?.body))
        return json({
          value: [
            {
              name: "refs/heads/feature",
              updateStatus: "succeeded",
            },
          ],
        })
      }
      return json({
        value: [{ name: "refs/heads/feature", objectId: "sha-abc" }],
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(service.deleteBranch(repository, "feature"))
    expect(postedBody).toEqual([
      {
        name: "refs/heads/feature",
        oldObjectId: "sha-abc",
        newObjectId: "0000000000000000000000000000000000000000",
      },
    ])
  })

  test("is idempotent when the branch no longer exists", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets/refs?filter=heads%2Ffeature&api-version=7.1":
          { value: [] },
      }),
    )
    await Effect.runPromise(service.deleteBranch(repository, "feature"))
  })
})

describe("Azure DevOps getOpenPullRequestNumber / findOpenPullRequestNumber", () => {
  test("finds the open pull request for the exact source branch", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1":
          {
            value: [
              {
                pullRequestId: 42,
                status: "active",
                isDraft: true,
                title: "t",
                description: "b",
                sourceRefName: "refs/heads/feature",
              },
            ],
          },
      }),
    )
    await expect(
      Effect.runPromise(
        service.findOpenPullRequestNumber(repository, "feature"),
      ),
    ).resolves.toBe(42)
    await expect(
      Effect.runPromise(
        service.getOpenPullRequestNumber(repository, "feature"),
      ),
    ).resolves.toBe(42)
  })

  test("findOpenPullRequestNumber returns null when none exists", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1":
          { value: [] },
      }),
    )
    await expect(
      Effect.runPromise(
        service.findOpenPullRequestNumber(repository, "feature"),
      ),
    ).resolves.toBeNull()
  })

  test("getOpenPullRequestNumber fails when none exists", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1":
          { value: [] },
      }),
    )
    const error = await Effect.runPromise(
      service.getOpenPullRequestNumber(repository, "feature").pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
  })
})

describe("Azure DevOps createDraftPullRequest", () => {
  test("creates a draft pull request against an explicit base", async () => {
    let requestBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      _input,
      init,
    ) => {
      requestBody = JSON.parse(String(init?.body))
      return json({
        pullRequestId: 7,
        status: "active",
        isDraft: true,
      })
    }) as unknown as typeof fetch)

    await expect(
      Effect.runPromise(
        service.createDraftPullRequest(repository, {
          headRefName: "feature",
          title: "t",
          body: "b",
          baseRefName: "main",
        }),
      ),
    ).resolves.toBe(7)
    expect(requestBody).toEqual({
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      title: "t",
      description: "b",
      isDraft: true,
    })
  })

  test("resolves the base branch from the repository default when omitted", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets?api-version=7.1": {
          defaultBranch: "refs/heads/main",
        },
        "POST /acme/widgets/_apis/git/repositories/widgets/pullrequests?api-version=7.1":
          { pullRequestId: 9, status: "active", isDraft: true },
      }),
    )
    await expect(
      Effect.runPromise(
        service.createDraftPullRequest(repository, {
          headRefName: "feature",
          title: "t",
          body: "b",
        }),
      ),
    ).resolves.toBe(9)
  })

  test("fails when Azure DevOps returns a non-draft pull request", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "POST /acme/widgets/_apis/git/repositories/widgets/pullrequests?api-version=7.1":
          { pullRequestId: 9, status: "active", isDraft: false },
      }),
    )
    const error = await Effect.runPromise(
      service
        .createDraftPullRequest(repository, {
          headRefName: "feature",
          title: "t",
          body: "b",
          baseRefName: "main",
        })
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
  })
})

describe("Azure DevOps updateOpenDraftPullRequestCopy", () => {
  test("updates title and description of an open draft pull request", async () => {
    let updateBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      if ((init?.method ?? "GET") === "PATCH") {
        updateBody = JSON.parse(String(init?.body))
        return json({ pullRequestId: 42, isDraft: true })
      }
      if (url.pathname.endsWith("/pullrequests")) {
        return json({
          value: [
            {
              pullRequestId: 42,
              status: "active",
              isDraft: true,
              title: "old title",
              description: "old body",
            },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as unknown as typeof fetch)

    await expect(
      Effect.runPromise(
        service.updateOpenDraftPullRequestCopy(repository, "feature", {
          title: "new title",
          body: "new body",
        }),
      ),
    ).resolves.toBe(42)
    expect(updateBody).toEqual({ title: "new title", description: "new body" })
  })

  test("returns null when no open pull request exists", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1":
          { value: [] },
      }),
    )
    await expect(
      Effect.runPromise(
        service.updateOpenDraftPullRequestCopy(repository, "feature", {
          title: "t",
          body: "b",
        }),
      ),
    ).resolves.toBeNull()
  })

  test("does not overwrite a non-draft open pull request", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1":
          {
            value: [
              {
                pullRequestId: 42,
                status: "active",
                isDraft: false,
                title: "ready title",
                description: "ready body",
              },
            ],
          },
      }),
    )
    await expect(
      Effect.runPromise(
        service.updateOpenDraftPullRequestCopy(repository, "feature", {
          title: "t",
          body: "b",
        }),
      ),
    ).resolves.toBe(42)
  })
})

describe("Azure DevOps markPullRequestReadyForReview", () => {
  test("clears the draft flag for an open draft pull request", async () => {
    let updateBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      if ((init?.method ?? "GET") === "PATCH") {
        updateBody = JSON.parse(String(init?.body))
        return json({ pullRequestId: 42, isDraft: false })
      }
      if (url.pathname.endsWith("/pullrequests")) {
        return json({
          value: [{ pullRequestId: 42, status: "active", isDraft: true }],
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.markPullRequestReadyForReview(repository, "feature"),
    )
    expect(updateBody).toEqual({ isDraft: false })
  })

  test("is idempotent when already ready for review", async () => {
    let patchCalled = false
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      _input,
      init,
    ) => {
      if ((init?.method ?? "GET") === "PATCH") {
        patchCalled = true
        return json({ pullRequestId: 42, isDraft: false })
      }
      return json({
        value: [{ pullRequestId: 42, status: "active", isDraft: false }],
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.markPullRequestReadyForReview(repository, "feature"),
    )
    expect(patchCalled).toBe(false)
  })

  test("fails when no open pull request exists", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/widgets/_apis/git/repositories/widgets/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1":
          { value: [] },
      }),
    )
    const error = await Effect.runPromise(
      service
        .markPullRequestReadyForReview(repository, "feature")
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
  })
})

// A project whose name differs from its Git repository name — the scenario
// from issue #15 (org `MSD-Production`, project `Default`, repository
// `gantry`). Project Path folds the repository name in as a third segment
// only because it differs from the project name (see
// AzureDevOpsRepository.projectPath doc).
const repositoryWithDistinctRepoName = {
  forge: "azure-devops",
  forgeHost: "dev.azure.com",
  projectPath: "MSD-Production/Default/gantry",
}

describe("Azure DevOps: Git repository name differs from project name", () => {
  test("createDraftPullRequest resolves the default base branch from the repository, not the project, resource", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/MSD-Production/Default/_apis/git/repositories/gantry?api-version=7.1":
          { defaultBranch: "refs/heads/main" },
        "POST /MSD-Production/Default/_apis/git/repositories/gantry/pullrequests?api-version=7.1":
          { pullRequestId: 9, status: "active", isDraft: true },
      }),
    )
    await expect(
      Effect.runPromise(
        service.createDraftPullRequest(repositoryWithDistinctRepoName, {
          headRefName: "feature",
          title: "t",
          body: "b",
        }),
      ),
    ).resolves.toBe(9)
  })

  test("findOpenPullRequestNumber / getOpenPullRequestNumber look up the pull request against the repository resource", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/MSD-Production/Default/_apis/git/repositories/gantry/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=refs%2Fheads%2Ffeature&api-version=7.1":
          {
            value: [
              {
                pullRequestId: 42,
                status: "active",
                isDraft: true,
                title: "t",
                description: "b",
                sourceRefName: "refs/heads/feature",
              },
            ],
          },
      }),
    )
    await expect(
      Effect.runPromise(
        service.findOpenPullRequestNumber(
          repositoryWithDistinctRepoName,
          "feature",
        ),
      ),
    ).resolves.toBe(42)
    await expect(
      Effect.runPromise(
        service.getOpenPullRequestNumber(
          repositoryWithDistinctRepoName,
          "feature",
        ),
      ),
    ).resolves.toBe(42)
  })

  test("markPullRequestReadyForReview clears the draft flag against the repository resource", async () => {
    let updateBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      expect(url.pathname).toContain(
        "/_apis/git/repositories/gantry/pullrequests",
      )
      if ((init?.method ?? "GET") === "PATCH") {
        updateBody = JSON.parse(String(init?.body))
        return json({ pullRequestId: 42, isDraft: false })
      }
      return json({
        value: [{ pullRequestId: 42, status: "active", isDraft: true }],
      })
    }) as unknown as typeof fetch)

    await Effect.runPromise(
      service.markPullRequestReadyForReview(
        repositoryWithDistinctRepoName,
        "feature",
      ),
    )
    expect(updateBody).toEqual({ isDraft: false })
  })

  test("mergePullRequest merges a ready pull request against the repository resource", async () => {
    let patchBody: unknown = null
    const service = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      expect(url.pathname.startsWith("/MSD-Production/Default/_apis/")).toBe(
        true,
      )
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "PATCH") {
        patchBody = JSON.parse(String(init?.body))
        return json({ pullRequestId: 42, status: "completed" })
      }
      if (url.pathname.endsWith("/statuses")) {
        return json({ value: [] })
      }
      if (url.pathname.includes("/policy/evaluations")) {
        return json({ value: [{ evaluationId: "e1", status: "approved" }] })
      }
      expect(url.pathname).toContain(
        "/_apis/git/repositories/gantry/pullrequests",
      )
      return json({
        value: [
          {
            pullRequestId: 42,
            status: "active",
            isDraft: false,
            mergeStatus: "succeeded",
            lastMergeSourceCommit: { commitId: "sha-1" },
            repository: { project: { id: "proj-1" } },
          },
        ],
      })
    }) as unknown as typeof fetch)

    const result = await Effect.runPromise(
      service.mergePullRequest(repositoryWithDistinctRepoName, "feature"),
    )
    expect(result).toEqual({ _tag: "merged" })
    expect(patchBody).toEqual({
      status: "completed",
      lastMergeSourceCommit: { commitId: "sha-1" },
      completionOptions: { transitionWorkItems: true },
    })
  })

  test("closeOpenPullRequestsForBranch and deleteBranch address the repository resource, not the project", async () => {
    const patched: number[] = []
    const closeService = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      expect(url.pathname).toContain(
        "/_apis/git/repositories/gantry/pullrequests",
      )
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "PATCH") {
        const match = /\/pullrequests\/(\d+)/.exec(url.pathname)
        patched.push(Number(match?.[1]))
        return json({ pullRequestId: Number(match?.[1]), status: "abandoned" })
      }
      return json({
        value: [{ pullRequestId: 1, status: "active", isDraft: false }],
      })
    }) as unknown as typeof fetch)
    await Effect.runPromise(
      closeService.closeOpenPullRequestsForBranch(
        repositoryWithDistinctRepoName,
        "feature",
      ),
    )
    expect(patched).toEqual([1])

    let postedBody: unknown = null
    const deleteService = makeAzureDevOpsServiceFromToken("test-pat", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      expect(url.pathname).toContain("/_apis/git/repositories/gantry/refs")
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "POST") {
        postedBody = JSON.parse(String(init?.body))
        return json({
          value: [{ name: "refs/heads/feature", updateStatus: "succeeded" }],
        })
      }
      return json({
        value: [{ name: "refs/heads/feature", objectId: "sha-abc" }],
      })
    }) as unknown as typeof fetch)
    await Effect.runPromise(
      deleteService.deleteBranch(repositoryWithDistinctRepoName, "feature"),
    )
    expect(postedBody).toEqual([
      {
        name: "refs/heads/feature",
        oldObjectId: "sha-abc",
        newObjectId: "0000000000000000000000000000000000000000",
      },
    ])
  })
})
