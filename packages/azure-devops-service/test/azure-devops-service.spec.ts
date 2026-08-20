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
        .verifyProject({ ...repository, projectPath: "acme/widgets/extra" })
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(AzureDevOpsRequestError)
  })
})

describe("Azure DevOps getAuthenticatedUserLogin", () => {
  test("resolves the Operator Forge User through the token", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/connectionData?api-version=7.1": {
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

  test("falls back to the authenticated user id when display name is absent", async () => {
    const service = makeAzureDevOpsServiceFromToken(
      "test-pat",
      fakeFetch({
        "/acme/_apis/connectionData?api-version=7.1": {
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
        "/acme/_apis/connectionData?api-version=7.1": new Response(
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

describe("Azure DevOps not-yet-implemented methods", () => {
  test("every remaining method fails with AzureDevOpsNotImplementedError", async () => {
    const service = makeAzureDevOpsServiceFromToken("test-pat", fetch)
    const cases: ReadonlyArray<{
      readonly method: string
      readonly run: () => Effect.Effect<unknown, unknown>
    }> = [
      {
        method: "listReadyIssues",
        run: () => service.listReadyIssues(repository),
      },
      {
        method: "countOpenNonDraftPullRequests",
        run: () => service.countOpenNonDraftPullRequests(repository),
      },
      {
        method: "getPullRequestCheckStatus",
        run: () => service.getPullRequestCheckStatus(repository, "feature"),
      },
      {
        method: "getPrStatusCheckDiagnostics",
        run: () => service.getPrStatusCheckDiagnostics(repository, []),
      },
      {
        method: "getPullRequestLifecycleStatus",
        run: () => service.getPullRequestLifecycleStatus(repository, "feature"),
      },
      {
        method: "mergePullRequest",
        run: () => service.mergePullRequest(repository, "feature"),
      },
      {
        method: "ensureIssueCompletedWithSummary",
        run: () =>
          service.ensureIssueCompletedWithSummary(
            repository,
            1,
            "wi-1",
            "summary",
          ),
      },
      {
        method: "closeOpenPullRequestsForBranch",
        run: () =>
          service.closeOpenPullRequestsForBranch(repository, "feature"),
      },
      {
        method: "deleteBranch",
        run: () => service.deleteBranch(repository, "feature"),
      },
    ]
    expect(cases).toHaveLength(9)
    for (const { method, run } of cases) {
      const error = await Effect.runPromise(run().pipe(Effect.flip))
      expect(error).toBeInstanceOf(AzureDevOpsNotImplementedError)
      if (error instanceof AzureDevOpsNotImplementedError) {
        expect(error.method).toBe(method)
      }
    }
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
