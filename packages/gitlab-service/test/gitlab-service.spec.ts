import { Effect, Result } from "effect"
import {
  GitLabProjectUnavailableError,
  GitLabRequestError,
  makeGitLabServiceFromToken,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const repository = {
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
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
    const response =
      responses[`${method} ${pathKey}`] ??
      (method === "GET" ? responses[pathKey] : undefined)
    if (response === undefined) {
      throw new Error(`Unexpected request: ${method} ${pathKey}`)
    }
    return response instanceof Response ? response : json(response)
  }) as typeof fetch

describe("GitLab issue-source adapter", () => {
  test("maps Ready Issues, body blockers, and closing merge requests", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/issues?state=opened&labels=ready-for-agent&per_page=100&page=1":
          [
            {
              iid: 3601642,
              title: "Refresh tokens",
              description: "Context\n\nBlocked by: #3601000, #3601001",
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/issues/3601642",
              created_at: "2026-07-20T01:02:03.000Z",
              state: "opened",
              author: { username: "alice" },
            },
            {
              iid: 3601643,
              title: "Ghost author",
              description: null,
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/issues/3601643",
              created_at: "2026-07-21T01:02:03.000Z",
              state: "opened",
              author: null,
            },
          ],
        "/api/v4/projects/project%2Foauth_client/merge_requests?scope=all&state=all&per_page=100&page=1":
          [
            {
              iid: 81,
              state: "opened",
              draft: true,
              description: "Closes #3601642",
            },
            {
              iid: 82,
              state: "merged",
              draft: false,
              description: "Fixes #3601642",
            },
            {
              iid: 83,
              state: "closed",
              draft: false,
              description: "Resolves #3601642",
            },
            {
              iid: 84,
              state: "opened",
              draft: false,
              description: "Mentions #3601642 without closing it",
            },
          ],
      }),
    )

    const issues = await Effect.runPromise(service.listReadyIssues(repository))

    expect(issues).toEqual([
      {
        number: 3601642,
        title: "Refresh tokens",
        body: "Context\n\nBlocked by: #3601000, #3601001",
        url: "https://git.drupalcode.org/project/oauth_client/-/issues/3601642",
        createdAt: new Date("2026-07-20T01:02:03.000Z"),
        state: "OPEN",
        author: "alice",
        parent: null,
        parentPosition: null,
        hasChildren: false,
        hierarchySupported: false,
        blockedBy: [
          {
            number: 3601000,
            url: "https://git.drupalcode.org/project/oauth_client/-/issues/3601000",
          },
          {
            number: 3601001,
            url: "https://git.drupalcode.org/project/oauth_client/-/issues/3601001",
          },
        ],
        closingPullRequests: [
          {
            number: 81,
            repository: "project/oauth_client",
            state: "OPEN",
            isDraft: true,
          },
          {
            number: 82,
            repository: "project/oauth_client",
            state: "MERGED",
            isDraft: false,
          },
          {
            number: 83,
            repository: "project/oauth_client",
            state: "CLOSED",
            isDraft: false,
          },
        ],
      },
      {
        number: 3601643,
        title: "Ghost author",
        body: "",
        url: "https://git.drupalcode.org/project/oauth_client/-/issues/3601643",
        createdAt: new Date("2026-07-21T01:02:03.000Z"),
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

  test("resolves the Operator Forge User through the token", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/user": { username: "operator" },
      }),
    )

    await expect(
      Effect.runPromise(service.getAuthenticatedUserLogin(repository)),
    ).resolves.toBe("operator")
  })

  test("verifies a project and rejects an unknown identity actionably", async () => {
    const present = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client": {
          path_with_namespace: "project/oauth_client",
        },
      }),
    )
    await expect(
      Effect.runPromise(present.verifyProject(repository)),
    ).resolves.toBeUndefined()

    const missing = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client": new Response("not found", {
          status: 404,
        }),
      }),
    )
    const result = await Effect.runPromise(
      missing.verifyProject(repository).pipe(Effect.result),
    )
    expect(result).toEqual(
      Result.fail(new GitLabProjectUnavailableError(repository)),
    )
  })

  test("preserves authentication status on request failures", async () => {
    const service = makeGitLabServiceFromToken(
      "expired",
      fakeFetch({
        "/api/v4/user": new Response("unauthorized", { status: 401 }),
      }),
    )
    const error = await Effect.runPromise(
      service.getAuthenticatedUserLogin(repository).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.statusCode).toBe(401)
  })
})

describe("GitLab draft MR and Close Issue adapter", () => {
  test("creates a draft merge request against the project default base", async () => {
    const bodies: unknown[] = []
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname === "/api/v4/projects/project%2Foauth_client"
      ) {
        return json({
          path_with_namespace: "project/oauth_client",
          default_branch: "1.x",
        })
      }
      if (
        method === "POST" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/merge_requests"
      ) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")))
        return json({
          iid: 91,
          draft: true,
          title: "Draft: Refresh tokens",
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch)

    await expect(
      Effect.runPromise(
        service.createDraftPullRequest(repository, {
          headRefName: "rfa/issue-3601642",
          title: "Refresh tokens",
          body: "Implements refresh.\n\nCloses #3601642",
        }),
      ),
    ).resolves.toBe(91)
    expect(bodies).toEqual([
      {
        source_branch: "rfa/issue-3601642",
        target_branch: "1.x",
        title: "Draft: Refresh tokens",
        description: "Implements refresh.\n\nCloses #3601642",
        draft: true,
      },
    ])
  })

  test("createDraftPullRequest fails when GitLab returns a non-draft MR", async () => {
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname === "/api/v4/projects/project%2Foauth_client"
      ) {
        return json({
          path_with_namespace: "project/oauth_client",
          default_branch: "1.x",
        })
      }
      if (
        method === "POST" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/merge_requests"
      ) {
        return json({ iid: 91, draft: false, title: "Refresh tokens" })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch)

    const error = await Effect.runPromise(
      service
        .createDraftPullRequest(repository, {
          headRefName: "rfa/issue-3601642",
          title: "Refresh tokens",
          body: "Closes #3601642",
        })
        .pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.message).toContain("did not create a draft")
  })

  test("updateOpenDraftPullRequestCopy preserves the Draft title prefix", async () => {
    const bodies: unknown[] = []
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/merge_requests"
      ) {
        return json([
          {
            iid: 17,
            draft: true,
            title: "Draft: old title",
            description: "old body",
          },
        ])
      }
      if (
        method === "PUT" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/merge_requests/17"
      ) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")))
        return json({ iid: 17, draft: true, title: "Draft: new title" })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch)

    await expect(
      Effect.runPromise(
        service.updateOpenDraftPullRequestCopy(repository, "rfa/issue-1", {
          title: "new title",
          body: "new body",
        }),
      ),
    ).resolves.toBe(17)
    expect(bodies).toEqual([
      {
        title: "Draft: new title",
        description: "new body",
      },
    ])
  })

  test("finds open merge requests by source branch and counts non-drafts", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fissue-1&per_page=100&page=1":
          [{ iid: 17, draft: true, title: "Draft", description: "body" }],
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&wip=no&per_page=100&page=1":
          [
            { iid: 1, draft: false, title: "Ready" },
            { iid: 2, draft: true, title: "Still draft flag" },
            { iid: 3, draft: false, title: "Also ready" },
            // Title-only draft (boolean missing/false) must not inflate count.
            { iid: 4, draft: false, title: "Draft: title-only draft" },
          ],
      }),
    )

    await expect(
      Effect.runPromise(
        service.findOpenPullRequestNumber(repository, "rfa/issue-1"),
      ),
    ).resolves.toBe(17)
    await expect(
      Effect.runPromise(service.countOpenNonDraftPullRequests(repository)),
    ).resolves.toBe(2)
  })

  test("posts a marked No-Change summary and closes the Issue", async () => {
    const mutations: Array<{ method: string; path: string; body: unknown }> = []
    const workItemId = "01KYQKSRTJ4N6C5F9EV37R2MZJ"
    const summary = "No repository changes required."
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      const path = `${url.pathname}${url.search}`
      if (
        method === "GET" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642"
      ) {
        return json({ iid: 3601642, state: "opened" })
      }
      if (
        method === "GET" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642/notes"
      ) {
        return json([])
      }
      if (
        method === "POST" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642/notes"
      ) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          body: string
        }
        mutations.push({ method, path: url.pathname, body })
        return json({ body: body.body })
      }
      if (
        method === "PUT" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642"
      ) {
        mutations.push({
          method,
          path: url.pathname,
          body: JSON.parse(String(init?.body ?? "{}")),
        })
        return json({ iid: 3601642, state: "closed" })
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    }) as typeof fetch)

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        3601642,
        workItemId,
        summary,
      ),
    )

    expect(mutations).toHaveLength(2)
    const noteMutation = mutations[0]
    expect(noteMutation?.method).toBe("POST")
    const noteBody = (noteMutation?.body as { body: string } | undefined)?.body
    expect(String(noteBody)).toContain(summary)
    expect(String(noteBody)).toContain(
      `<!-- ready-for-agent:work-item:${workItemId} -->`,
    )
    expect(mutations[1]).toEqual({
      method: "PUT",
      path: "/api/v4/projects/project%2Foauth_client/issues/3601642",
      body: { state_event: "close" },
    })
  })

  test("reuses an existing marked comment without posting a duplicate", async () => {
    const mutations: string[] = []
    const workItemId = "01KYQKSRTJ4N6C5F9EV37R2MZJ"
    const marker = `<!-- ready-for-agent:work-item:${workItemId} -->`
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642"
      ) {
        return json({ iid: 3601642, state: "opened" })
      }
      if (
        method === "GET" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642/notes"
      ) {
        return json([{ body: `## Done\n\n${marker}` }])
      }
      if (
        method === "POST" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642/notes"
      ) {
        mutations.push("note")
        return json({ body: "should not post" })
      }
      if (
        method === "PUT" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/issues/3601642"
      ) {
        mutations.push("close")
        return json({ iid: 3601642, state: "closed" })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch)

    await Effect.runPromise(
      service.ensureIssueCompletedWithSummary(
        repository,
        3601642,
        workItemId,
        "## Summary",
      ),
    )
    expect(mutations).toEqual(["close"])
  })

  test("closes open merge requests for a branch and deletes the branch", async () => {
    const mutations: string[] = []
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/merge_requests" &&
        url.search.includes("source_branch=rfa%2Fissue-1")
      ) {
        return json([
          { iid: 10, draft: true },
          { iid: 11, draft: false },
        ])
      }
      if (
        method === "PUT" &&
        url.pathname.startsWith(
          "/api/v4/projects/project%2Foauth_client/merge_requests/",
        )
      ) {
        mutations.push(`close:${url.pathname.split("/").at(-1)}`)
        return json({
          iid: Number(url.pathname.split("/").at(-1)),
          draft: true,
        })
      }
      if (
        method === "DELETE" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/repository/branches/rfa%2Fissue-1"
      ) {
        mutations.push("delete-branch")
        return new Response(null, { status: 204 })
      }
      throw new Error(
        `Unexpected request: ${method} ${url.pathname}${url.search}`,
      )
    }) as typeof fetch)

    await Effect.runPromise(
      service.closeOpenPullRequestsForBranch(repository, "rfa/issue-1"),
    )
    await Effect.runPromise(service.deleteBranch(repository, "rfa/issue-1"))
    expect(mutations).toEqual(["close:10", "close:11", "delete-branch"])
  })

  test("treats a missing branch as successful delete", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "DELETE /api/v4/projects/project%2Foauth_client/repository/branches/gone":
          new Response("not found", { status: 404 }),
      }),
    )
    await expect(
      Effect.runPromise(service.deleteBranch(repository, "gone")),
    ).resolves.toBeUndefined()
  })
})
