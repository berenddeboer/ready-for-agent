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
        method: "getOpenPullRequestNumber",
        run: () => service.getOpenPullRequestNumber(repository, "feature"),
      },
      {
        method: "findOpenPullRequestNumber",
        run: () => service.findOpenPullRequestNumber(repository, "feature"),
      },
      {
        method: "createDraftPullRequest",
        run: () =>
          service.createDraftPullRequest(repository, {
            headRefName: "feature",
            title: "t",
            body: "b",
          }),
      },
      {
        method: "updateOpenDraftPullRequestCopy",
        run: () =>
          service.updateOpenDraftPullRequestCopy(repository, "feature", {
            title: "t",
            body: "b",
          }),
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
        method: "markPullRequestReadyForReview",
        run: () => service.markPullRequestReadyForReview(repository, "feature"),
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
    expect(cases).toHaveLength(14)
    for (const { method, run } of cases) {
      const error = await Effect.runPromise(run().pipe(Effect.flip))
      expect(error).toBeInstanceOf(AzureDevOpsNotImplementedError)
      if (error instanceof AzureDevOpsNotImplementedError) {
        expect(error.method).toBe(method)
      }
    }
  })
})
