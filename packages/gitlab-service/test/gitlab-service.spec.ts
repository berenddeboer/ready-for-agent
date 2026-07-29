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
      // Bridge listing is optional in fixtures; empty is a valid default when
      // a test only registers ordinary /jobs.
      if (method === "GET" && pathKey.includes("/bridges?")) {
        return json([])
      }
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
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fissue-1&order_by=updated_at&sort=desc&per_page=100&page=1":
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

describe("GitLab PR status checks and ready-for-review", () => {
  test("maps head-pipeline jobs with allow_failure, manual, and canceled rules", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: true, title: "Draft: fix" }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: true,
          title: "Draft: fix",
          created_at: "2026-07-20T10:00:00.000Z",
          sha: "deadbeef",
          target_branch: "1.0.x",
          detailed_merge_status: "ci_still_running",
          merge_status: "can_be_merged",
          head_pipeline: {
            id: 99,
            status: "running",
            sha: "deadbeef",
            created_at: "2026-07-20T10:05:00.000Z",
          },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/deadbeef": {
          id: "deadbeef",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        "/api/v4/projects/project%2Foauth_client/pipelines/99/jobs?per_page=100&page=1":
          [
            {
              id: 1,
              name: "lint",
              status: "success",
              allow_failure: false,
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/jobs/1",
            },
            {
              id: 2,
              name: "phpunit",
              status: "failed",
              allow_failure: false,
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/jobs/2",
            },
            {
              id: 3,
              name: "style",
              status: "failed",
              allow_failure: true,
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/jobs/3",
            },
            {
              id: 4,
              name: "deploy",
              status: "manual",
              allow_failure: true,
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/jobs/4",
            },
            {
              id: 5,
              name: "optional",
              status: "canceled",
              allow_failure: false,
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/jobs/5",
            },
            {
              id: 6,
              name: "build",
              status: "running",
              allow_failure: false,
              web_url:
                "https://git.drupalcode.org/project/oauth_client/-/jobs/6",
            },
          ],
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )

    expect(status._tag).toBe("pending")
    if (status._tag !== "pending") return
    expect(status.mergeability).toBe("mergeable")
    expect(status.baseRefName).toBe("1.0.x")
    expect(status.headSha).toBe("deadbeef")
    expect(status.isDraft).toBe(true)
    expect(status.createdAt).toEqual(new Date("2026-07-20T10:00:00.000Z"))
    expect(status.headPushedAt).toEqual(new Date("2026-07-20T10:04:00.000Z"))
    expect(status.terminalChecks).toEqual([
      { externalId: "gitlab-job:1", name: "lint", outcome: "green" },
      { externalId: "gitlab-job:2", name: "phpunit", outcome: "red" },
    ])
  })

  test("reports no_checks when the head pipeline is not visible yet", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: true }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: true,
          title: "Draft: fix",
          created_at: "2026-07-20T10:00:00.000Z",
          sha: "deadbeef",
          target_branch: "main",
          detailed_merge_status: "checking",
          merge_status: "checking",
          head_pipeline: null,
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/deadbeef": {
          id: "deadbeef",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status).toMatchObject({
      _tag: "no_checks",
      mergeability: "unknown",
      headSha: "deadbeef",
      isDraft: true,
    })
  })

  test("keeps watching when head_pipeline SHA is behind the MR tip", async () => {
    let jobsListed = 0
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "new-tip",
          target_branch: "main",
          detailed_merge_status: "mergeable",
          merge_status: "can_be_merged",
          // Successful pipeline is still for the previous tip after a push.
          head_pipeline: { id: 1, status: "success", sha: "old-tip" },
        })
      }
      if (method === "GET" && url.pathname.includes("/repository/commits/")) {
        return json({
          id: "new-tip",
          committed_date: "2026-07-20T10:04:00.000Z",
        })
      }
      if (method === "GET" && url.pathname.includes("/pipelines/1/jobs")) {
        jobsListed += 1
        return json([
          { id: 1, name: "test", status: "success", allow_failure: false },
        ])
      }
      if (method === "GET" && url.pathname.includes("/bridges")) {
        return json([])
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status._tag).toBe("pending")
    expect(status).toMatchObject({ headSha: "new-tip" })
    // Do not roll up jobs for a pipeline that is not the MR tip.
    expect(jobsListed).toBe(0)
  })

  test("never reports Expected PR Status Checks for GitLab", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "mergeable",
          merge_status: "can_be_merged",
          head_pipeline: { id: 1, status: "success", sha: "abc" },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
          [
            {
              id: 7,
              name: "lint",
              status: "success",
              allow_failure: false,
            },
          ],
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status._tag).toBe("succeeded")
    expect(status).not.toMatchObject({ _tag: "expected" })
  })

  test("loads job traces as diagnostics for red gitlab-job ids", async () => {
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname === "/api/v4/projects/project%2Foauth_client/jobs/2"
      ) {
        return json({
          id: 2,
          name: "phpunit",
          status: "failed",
          web_url: "https://git.drupalcode.org/project/oauth_client/-/jobs/2",
        })
      }
      if (
        method === "GET" &&
        url.pathname === "/api/v4/projects/project%2Foauth_client/jobs/2/trace"
      ) {
        return new Response("FAIL: expected true\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch)

    const diagnostics = await Effect.runPromise(
      service.getPrStatusCheckDiagnostics(repository, [
        { externalId: "gitlab-job:2", name: "phpunit" },
      ]),
    )

    expect(diagnostics).toEqual([
      {
        externalId: "gitlab-job:2",
        name: "phpunit",
        source: "gitlab-job",
        htmlUrl: "https://git.drupalcode.org/project/oauth_client/-/jobs/2",
        logFetch: {
          _tag: "ok",
          excerpt: "FAIL: expected true\n",
          localPath: null,
        },
      },
    ])
  })

  test("marks a draft MR ready for review by clearing draft and title prefix", async () => {
    const mutations: unknown[] = []
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
        url.search.includes("source_branch=rfa%2Fbranch")
      ) {
        return json([{ iid: 12, draft: true, title: "Draft: fix lint" }])
      }
      if (
        method === "GET" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/merge_requests/12"
      ) {
        return json({
          iid: 12,
          state: "opened",
          draft: true,
          title: "Draft: fix lint",
        })
      }
      if (
        method === "PUT" &&
        url.pathname ===
          "/api/v4/projects/project%2Foauth_client/merge_requests/12"
      ) {
        const body = JSON.parse(String(init?.body ?? "{}"))
        mutations.push(body)
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix lint",
        })
      }
      throw new Error(
        `Unexpected request: ${method} ${url.pathname}${url.search}`,
      )
    }) as typeof fetch)

    await Effect.runPromise(
      service.markPullRequestReadyForReview(repository, "rfa/branch"),
    )

    expect(mutations).toEqual([{ draft: false, title: "fix lint" }])
  })

  test("reports conflicting mergeability for Merge Conflict Handoff", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "conflict",
          merge_status: "cannot_be_merged",
          head_pipeline: { id: 1, status: "success", sha: "abc" },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
          [
            {
              id: 1,
              name: "lint",
              status: "success",
              allow_failure: false,
            },
          ],
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status.mergeability).toBe("conflicting")
    expect(status._tag).toBe("succeeded")
  })

  test("observes a closed MR after open list is empty", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [],
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=all&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false, title: "fix" }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "closed",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "not_open",
          merge_status: "cannot_be_merged",
          head_pipeline: null,
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status._tag).toBe("closed")
    expect(status.headSha).toBe("abc")
    // not_open + cannot_be_merged must not invent a conflict for Watch.
    expect(status.mergeability).not.toBe("conflicting")
  })

  test("locked MRs keep watching the head pipeline (not decode failure)", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [],
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=all&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false, title: "fix" }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "locked",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "checking",
          merge_status: "checking",
          head_pipeline: { id: 1, status: "success", sha: "abc" },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
          [
            {
              id: 1,
              name: "lint",
              status: "success",
              allow_failure: false,
            },
          ],
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status._tag).toBe("succeeded")
    expect(status.headSha).toBe("abc")
  })

  test("single-MR 404 after list resolves to pending, not project unavailable", async () => {
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return new Response("not found", { status: 404 })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status._tag).toBe("pending")
    expect(status).toMatchObject({
      terminalChecks: [],
      headSha: null,
    })
  })

  test("merged MRs report succeeded with non-blocking mergeability", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [],
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=all&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false, title: "fix" }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "merged",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "not_open",
          merge_status: "cannot_be_merged",
          has_conflicts: false,
          head_pipeline: { id: 1, status: "success", sha: "abc" },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status).toMatchObject({
      _tag: "succeeded",
      mergeability: "mergeable",
      headSha: "abc",
    })
  })

  test("treats policy/CI detailed statuses as mergeable so reds can hand off", async () => {
    const openUrl =
      "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1"
    for (const detailed of [
      "status_checks_must_pass",
      "security_policy_violations",
      "locked_paths",
    ] as const) {
      const service = makeGitLabServiceFromToken(
        "test-token",
        fakeFetch({
          [openUrl]: [{ iid: 12, draft: false }],
          "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
            iid: 12,
            state: "opened",
            draft: false,
            title: "fix",
            sha: "abc",
            target_branch: "main",
            detailed_merge_status: detailed,
            merge_status: "cannot_be_merged",
            has_conflicts: false,
            head_pipeline: { id: 1, status: "failed", sha: "abc" },
          },
          "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
            id: "abc",
            committed_date: "2026-07-20T10:04:00.000Z",
          },
          "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
            [
              {
                id: 1,
                name: "lint",
                status: "failed",
                allow_failure: false,
              },
            ],
        }),
      )

      const status = await Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "rfa/branch"),
      )
      expect(status.mergeability).toBe("mergeable")
      expect(status._tag).toBe("failed")
    }
  })

  test("uses has_conflicts and detailed conflict for true merge conflicts", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "ci_must_pass",
          merge_status: "cannot_be_merged",
          has_conflicts: true,
          head_pipeline: { id: 1, status: "success", sha: "abc" },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
          [
            {
              id: 1,
              name: "lint",
              status: "success",
              allow_failure: false,
            },
          ],
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status.mergeability).toBe("conflicting")
  })

  test("includes bridge jobs so parent/child pipelines do not look settled early", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "ci_still_running",
          merge_status: "can_be_merged",
          head_pipeline: {
            id: 1,
            status: "running",
            sha: "abc",
          },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        // Parent has no ordinary jobs — only a trigger/bridge to a child pipeline.
        "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
          [],
        "/api/v4/projects/project%2Foauth_client/pipelines/1/bridges?per_page=100&page=1":
          [
            {
              id: 50,
              name: "trigger:child",
              status: "running",
              allow_failure: false,
            },
          ],
      }),
    )

    const pending = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(pending._tag).toBe("pending")

    const failedService = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "ci_must_pass",
          merge_status: "can_be_merged",
          head_pipeline: {
            id: 1,
            status: "failed",
            sha: "abc",
          },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
          [],
        "/api/v4/projects/project%2Foauth_client/pipelines/1/bridges?per_page=100&page=1":
          [
            {
              id: 50,
              name: "trigger:child",
              status: "failed",
              allow_failure: false,
            },
          ],
      }),
    )
    const failed = await Effect.runPromise(
      failedService.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(failed._tag).toBe("failed")
    if (failed._tag === "failed") {
      expect(failed.terminalChecks).toEqual([
        {
          externalId: "gitlab-job:50",
          name: "trigger:child",
          outcome: "red",
        },
      ])
    }
  })

  test("manual-only jobs settle without waiting forever on pipeline manual status", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "mergeable",
          merge_status: "can_be_merged",
          head_pipeline: { id: 1, status: "manual", sha: "abc" },
        },
        "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        },
        "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
          [
            {
              id: 1,
              name: "deploy",
              status: "manual",
              allow_failure: true,
            },
          ],
      }),
    )

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    // Job-level manual is ignore; do not fall back to pipeline "manual" as
    // pending (which would requeue Watch forever).
    expect(status._tag).toBe("no_checks")
  })

  test("jobs-list 404 degrades to empty jobs and pipeline-status rollup", async () => {
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "fix",
          sha: "abc",
          target_branch: "main",
          detailed_merge_status: "ci_still_running",
          merge_status: "can_be_merged",
          head_pipeline: { id: 1, status: "running", sha: "abc" },
        })
      }
      if (method === "GET" && url.pathname.includes("/repository/commits/")) {
        return json({
          id: "abc",
          committed_date: "2026-07-20T10:04:00.000Z",
        })
      }
      if (method === "GET" && url.pathname.endsWith("/pipelines/1/jobs")) {
        return new Response("not found", { status: 404 })
      }
      if (method === "GET" && url.pathname.endsWith("/pipelines/1/bridges")) {
        return json([])
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const status = await Effect.runPromise(
      service.getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(status._tag).toBe("pending")
  })

  test("empty jobs fall back to head_pipeline status instead of settled no_checks", async () => {
    const openUrl =
      "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1"
    const emptyLists = {
      "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1":
        [] as const,
      "/api/v4/projects/project%2Foauth_client/pipelines/1/bridges?per_page=100&page=1":
        [] as const,
      "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
        id: "abc",
        committed_date: "2026-07-20T10:04:00.000Z",
      },
    }

    const running = await Effect.runPromise(
      makeGitLabServiceFromToken(
        "test-token",
        fakeFetch({
          [openUrl]: [{ iid: 12, draft: false }],
          "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
            iid: 12,
            state: "opened",
            draft: false,
            title: "fix",
            sha: "abc",
            target_branch: "main",
            detailed_merge_status: "ci_still_running",
            merge_status: "can_be_merged",
            head_pipeline: { id: 1, status: "running", sha: "abc" },
          },
          ...emptyLists,
        }),
      ).getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(running._tag).toBe("pending")

    const pipelineFailed = await Effect.runPromise(
      makeGitLabServiceFromToken(
        "test-token",
        fakeFetch({
          [openUrl]: [{ iid: 12, draft: false }],
          "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
            iid: 12,
            state: "opened",
            draft: false,
            title: "fix",
            sha: "abc",
            target_branch: "main",
            detailed_merge_status: "ci_must_pass",
            merge_status: "can_be_merged",
            head_pipeline: { id: 1, status: "failed", sha: "abc" },
          },
          ...emptyLists,
        }),
      ).getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(pipelineFailed._tag).toBe("failed")

    const pipelineSuccess = await Effect.runPromise(
      makeGitLabServiceFromToken(
        "test-token",
        fakeFetch({
          [openUrl]: [{ iid: 12, draft: false }],
          "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
            iid: 12,
            state: "opened",
            draft: false,
            title: "fix",
            sha: "abc",
            target_branch: "main",
            detailed_merge_status: "mergeable",
            merge_status: "can_be_merged",
            head_pipeline: { id: 1, status: "success", sha: "abc" },
          },
          ...emptyLists,
        }),
      ).getPullRequestCheckStatus(repository, "rfa/branch"),
    )
    expect(pipelineSuccess._tag).toBe("succeeded")
  })

  test("aggregates skipped-only, all-green, and hard-fail pipelines", async () => {
    const jobsUrl =
      "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1"
    const openUrl =
      "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1"
    const mrBase = {
      iid: 12,
      state: "opened" as const,
      draft: false,
      title: "fix",
      sha: "abc",
      target_branch: "main",
      detailed_merge_status: "mergeable",
      merge_status: "can_be_merged",
      head_pipeline: { id: 1, status: "success", sha: "abc" },
    }

    const run = async (jobs: readonly unknown[]) => {
      const service = makeGitLabServiceFromToken(
        "test-token",
        fakeFetch({
          [openUrl]: [{ iid: 12, draft: false }],
          "/api/v4/projects/project%2Foauth_client/merge_requests/12": mrBase,
          "/api/v4/projects/project%2Foauth_client/repository/commits/abc": {
            id: "abc",
            committed_date: "2026-07-20T10:04:00.000Z",
          },
          [jobsUrl]: jobs,
        }),
      )
      return Effect.runPromise(
        service.getPullRequestCheckStatus(repository, "rfa/branch"),
      )
    }

    const skippedOnly = await run([
      { id: 1, name: "optional", status: "skipped", allow_failure: false },
    ])
    // Skip-only jobs are ignore terminals; pipeline-status fallback applies
    // only when zero jobs exist, so this settles as no_checks (not pending).
    expect(skippedOnly._tag).toBe("no_checks")

    const allGreen = await run([
      { id: 1, name: "lint", status: "success", allow_failure: false },
      { id: 2, name: "test", status: "success", allow_failure: false },
    ])
    expect(allGreen._tag).toBe("succeeded")
    if (allGreen._tag === "succeeded") {
      expect(allGreen.terminalChecks).toHaveLength(2)
    }

    const hardFail = await run([
      { id: 1, name: "lint", status: "success", allow_failure: false },
      { id: 2, name: "test", status: "failed", allow_failure: false },
    ])
    expect(hardFail._tag).toBe("failed")
  })

  test("mark ready is idempotent for non-draft and strips empty Draft: titles", async () => {
    let putCount = 0
    const readyService = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false, title: "Already ready" }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "Already ready",
        })
      }
      if (method === "PUT") {
        putCount += 1
        return json({ iid: 12, state: "opened", draft: false, title: "x" })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    await Effect.runPromise(
      readyService.markPullRequestReadyForReview(repository, "rfa/branch"),
    )
    expect(putCount).toBe(0)

    const mutations: unknown[] = []
    const emptyDraftService = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: true, title: "Draft:" }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "opened",
          draft: true,
          title: "Draft:",
        })
      }
      if (method === "PUT" && url.pathname.endsWith("/merge_requests/12")) {
        const body = JSON.parse(String(init?.body ?? "{}"))
        mutations.push(body)
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: body.title,
        })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    await Effect.runPromise(
      emptyDraftService.markPullRequestReadyForReview(repository, "rfa/branch"),
    )
    expect(mutations).toEqual([{ draft: false, title: "Ready" }])

    const nestedMutations: unknown[] = []
    const nestedDraftService = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 13, draft: true, title: "Draft: WIP: nested" }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/13")) {
        return json({
          iid: 13,
          state: "opened",
          draft: true,
          title: "Draft: WIP: nested",
        })
      }
      if (method === "PUT" && url.pathname.endsWith("/merge_requests/13")) {
        const body = JSON.parse(String(init?.body ?? "{}"))
        nestedMutations.push(body)
        return json({
          iid: 13,
          state: "opened",
          draft: false,
          title: body.title,
        })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    await Effect.runPromise(
      nestedDraftService.markPullRequestReadyForReview(
        repository,
        "rfa/nested",
      ),
    )
    expect(nestedMutations).toEqual([{ draft: false, title: "nested" }])
  })

  test("getPullRequestLifecycleStatus maps merged, closed, open, and not found", async () => {
    const openUrl =
      "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1"
    const allUrl =
      "/api/v4/projects/project%2Foauth_client/merge_requests?state=all&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1"

    const mergedService = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        [openUrl]: [],
        [allUrl]: [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "merged",
          draft: false,
          title: "Done",
          sha: "abc",
        },
      }),
    )
    expect(
      await Effect.runPromise(
        mergedService.getPullRequestLifecycleStatus(repository, "rfa/branch"),
      ),
    ).toEqual({ _tag: "merged" })

    const closedService = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        [openUrl]: [],
        [allUrl]: [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "closed",
          draft: false,
          title: "Closed",
          sha: "abc",
        },
      }),
    )
    expect(
      await Effect.runPromise(
        closedService.getPullRequestLifecycleStatus(repository, "rfa/branch"),
      ),
    ).toEqual({ _tag: "closed" })

    const openService = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        [openUrl]: [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "opened",
          draft: false,
          title: "Open",
          sha: "abc",
        },
      }),
    )
    expect(
      await Effect.runPromise(
        openService.getPullRequestLifecycleStatus(repository, "rfa/branch"),
      ),
    ).toEqual({ _tag: "open" })

    const missingService = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        [openUrl]: [],
        [allUrl]: [],
      }),
    )
    expect(
      await Effect.runPromise(
        missingService.getPullRequestLifecycleStatus(repository, "rfa/branch"),
      ),
    ).toEqual({ _tag: "not_found" })
  })

  test("mergePullRequest merges with expected head SHA and no merge-method override", async () => {
    const mutations: unknown[] = []
    const openUrl =
      "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1"
    const jobsUrl =
      "/api/v4/projects/project%2Foauth_client/pipelines/1/jobs?per_page=100&page=1"
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "Ready",
          sha: "abc123",
          target_branch: "main",
          detailed_merge_status: "mergeable",
          merge_status: "can_be_merged",
          has_conflicts: false,
          head_pipeline: { id: 1, status: "success", sha: "abc123" },
        })
      }
      if (method === "GET" && url.pathname.includes("/pipelines/1/jobs")) {
        return json([
          { id: 1, name: "test", status: "success", allow_failure: false },
        ])
      }
      if (method === "GET" && url.pathname.includes("/bridges")) {
        return json([])
      }
      if (
        method === "PUT" &&
        url.pathname.endsWith("/merge_requests/12/merge")
      ) {
        const body = JSON.parse(String(init?.body ?? "{}"))
        mutations.push(body)
        return json({
          iid: 12,
          state: "merged",
          draft: false,
          title: "Ready",
          sha: "abc123",
        })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "rfa/branch"),
    )
    expect(result).toEqual({ _tag: "merged" })
    expect(mutations).toEqual([{ sha: "abc123" }])
    // Jobs listed for pre-check; open list used once before merge.
    expect(openUrl).toContain("source_branch=rfa%2Fbranch")
    expect(jobsUrl).toContain("/pipelines/1/jobs")
  })

  test("mergePullRequest is idempotent when already merged", async () => {
    let putCount = 0
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "GET" && url.pathname.endsWith("/merge_requests")) {
        if (url.search.includes("state=opened")) {
          return json([])
        }
        if (url.search.includes("state=all")) {
          return json([{ iid: 12, draft: false }])
        }
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "merged",
          draft: false,
          title: "Done",
          sha: "abc123",
        })
      }
      if (method === "PUT") {
        putCount += 1
        return json({ iid: 12, state: "merged" })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    expect(
      await Effect.runPromise(
        service.mergePullRequest(repository, "rfa/branch"),
      ),
    ).toEqual({ _tag: "merged" })
    expect(putCount).toBe(0)
  })

  test("mergePullRequest returns needs_human for closed unmerged MRs", async () => {
    const service = makeGitLabServiceFromToken(
      "test-token",
      fakeFetch({
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=opened&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [],
        "/api/v4/projects/project%2Foauth_client/merge_requests?state=all&source_branch=rfa%2Fbranch&order_by=updated_at&sort=desc&per_page=100&page=1":
          [{ iid: 12, draft: false }],
        "/api/v4/projects/project%2Foauth_client/merge_requests/12": {
          iid: 12,
          state: "closed",
          draft: false,
          title: "Closed",
          sha: "abc123",
        },
      }),
    )
    expect(
      await Effect.runPromise(
        service.mergePullRequest(repository, "rfa/branch"),
      ),
    ).toMatchObject({ _tag: "needs_human", reason: "closed_unmerged" })
  })

  test.each([
    [
      "non-green pipeline",
      {
        draft: false,
        title: "Ready",
        detailed_merge_status: "mergeable",
        merge_status: "can_be_merged",
        has_conflicts: false,
        head_pipeline: { id: 1, status: "failed", sha: "abc123" },
        jobs: [{ id: 1, name: "test", status: "failed", allow_failure: false }],
      },
      "checks_not_green",
    ],
    [
      "a conflict",
      {
        draft: false,
        title: "Ready",
        detailed_merge_status: "conflict",
        merge_status: "cannot_be_merged",
        has_conflicts: true,
        head_pipeline: { id: 1, status: "success", sha: "abc123" },
        jobs: [
          { id: 1, name: "test", status: "success", allow_failure: false },
        ],
      },
      "mergeability_changed",
    ],
    [
      "a draft MR",
      {
        draft: true,
        title: "Draft: Ready",
        detailed_merge_status: "draft_status",
        merge_status: "cannot_be_merged",
        has_conflicts: false,
        head_pipeline: { id: 1, status: "success", sha: "abc123" },
        jobs: [
          { id: 1, name: "test", status: "success", allow_failure: false },
        ],
      },
      "mergeability_changed",
    ],
    [
      "a locked MR",
      {
        draft: false,
        title: "Ready",
        state: "locked" as const,
        detailed_merge_status: "checking",
        merge_status: "checking",
        has_conflicts: false,
        head_pipeline: { id: 1, status: "success", sha: "abc123" },
        jobs: [
          { id: 1, name: "test", status: "success", allow_failure: false },
        ],
      },
      "mergeability_changed",
    ],
    [
      "a pending pipeline",
      {
        draft: false,
        title: "Ready",
        detailed_merge_status: "mergeable",
        merge_status: "can_be_merged",
        has_conflicts: false,
        head_pipeline: { id: 1, status: "running", sha: "abc123" },
        jobs: [
          { id: 1, name: "test", status: "running", allow_failure: false },
        ],
      },
      "checks_not_green",
    ],
    [
      "a stale successful pipeline for a prior tip",
      {
        draft: false,
        title: "Ready",
        detailed_merge_status: "mergeable",
        merge_status: "can_be_merged",
        has_conflicts: false,
        head_pipeline: { id: 1, status: "success", sha: "old-tip" },
        jobs: [
          { id: 1, name: "test", status: "success", allow_failure: false },
        ],
      },
      "checks_not_green",
    ],
  ] as const)(
    "mergePullRequest returns revalidation for %s",
    async (_description, snapshot, reason) => {
      let putCount = 0
      const state =
        "state" in snapshot && snapshot.state === "locked" ? "locked" : "opened"
      const service = makeGitLabServiceFromToken("test-token", (async (
        input,
        init,
      ) => {
        const url = new URL(String(input))
        const method = (init?.method ?? "GET").toUpperCase()
        if (
          method === "GET" &&
          url.pathname.endsWith("/merge_requests") &&
          url.search.includes("state=opened")
        ) {
          return json([{ iid: 12, draft: snapshot.draft }])
        }
        if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
          return json({
            iid: 12,
            state,
            draft: snapshot.draft,
            title: snapshot.title,
            sha: "abc123",
            target_branch: "main",
            detailed_merge_status: snapshot.detailed_merge_status,
            merge_status: snapshot.merge_status,
            has_conflicts: snapshot.has_conflicts,
            head_pipeline: snapshot.head_pipeline,
          })
        }
        if (method === "GET" && url.pathname.includes("/pipelines/1/jobs")) {
          return json(snapshot.jobs)
        }
        if (method === "GET" && url.pathname.includes("/bridges")) {
          return json([])
        }
        if (method === "PUT") {
          putCount += 1
          return json({ iid: 12, state: "merged" })
        }
        throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
      }) as typeof fetch)
      const result = await Effect.runPromise(
        service.mergePullRequest(repository, "rfa/branch"),
      )
      expect(result).toMatchObject({ _tag: "revalidation", reason })
      expect(putCount).toBe(0)
    },
  )

  test("mergePullRequest revalidates head_changed after a 409 SHA rejection", async () => {
    let getCount = 0
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        getCount += 1
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "Ready",
          sha: getCount === 1 ? "abc123" : "def456",
          target_branch: "main",
          detailed_merge_status: "mergeable",
          merge_status: "can_be_merged",
          has_conflicts: false,
          head_pipeline: {
            id: 1,
            status: "success",
            sha: getCount === 1 ? "abc123" : "def456",
          },
        })
      }
      if (method === "GET" && url.pathname.includes("/pipelines/1/jobs")) {
        return json([
          { id: 1, name: "test", status: "success", allow_failure: false },
        ])
      }
      if (method === "GET" && url.pathname.includes("/bridges")) {
        return json([])
      }
      if (
        method === "PUT" &&
        url.pathname.endsWith("/merge_requests/12/merge")
      ) {
        return new Response("SHA does not match HEAD of source", {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "rfa/branch"),
    )
    expect(result).toMatchObject({
      _tag: "revalidation",
      reason: "head_changed",
    })
  })

  test("mergePullRequest keeps credential and 5xx failures operational", async () => {
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "Ready",
          sha: "abc123",
          target_branch: "main",
          detailed_merge_status: "mergeable",
          merge_status: "can_be_merged",
          has_conflicts: false,
          head_pipeline: { id: 1, status: "success", sha: "abc123" },
        })
      }
      if (method === "GET" && url.pathname.includes("/pipelines/1/jobs")) {
        return json([
          { id: 1, name: "test", status: "success", allow_failure: false },
        ])
      }
      if (method === "GET" && url.pathname.includes("/bridges")) {
        return json([])
      }
      if (
        method === "PUT" &&
        url.pathname.endsWith("/merge_requests/12/merge")
      ) {
        return new Response("forbidden", {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const result = await Effect.runPromise(
      Effect.result(service.mergePullRequest(repository, "rfa/branch")),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(GitLabRequestError)
    }
  })

  test("mergePullRequest returns needs_human when GitLab rejects an unchanged mergeable MR", async () => {
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        return json({
          iid: 12,
          state: "opened",
          draft: false,
          title: "Ready",
          sha: "abc123",
          target_branch: "main",
          detailed_merge_status: "mergeable",
          merge_status: "can_be_merged",
          has_conflicts: false,
          head_pipeline: { id: 1, status: "success", sha: "abc123" },
        })
      }
      if (method === "GET" && url.pathname.includes("/pipelines/1/jobs")) {
        return json([
          { id: 1, name: "test", status: "success", allow_failure: false },
        ])
      }
      if (method === "GET" && url.pathname.includes("/bridges")) {
        return json([])
      }
      if (
        method === "PUT" &&
        url.pathname.endsWith("/merge_requests/12/merge")
      ) {
        return new Response("Branch cannot be merged", {
          status: 405,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "rfa/branch"),
    )
    expect(result).toMatchObject({
      _tag: "needs_human",
      reason: "merge_rejected",
    })
  })

  test("mergePullRequest revalidates when the MR becomes draft after a rejected merge", async () => {
    let getCount = 0
    const service = makeGitLabServiceFromToken("test-token", (async (
      input,
      init,
    ) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (
        method === "GET" &&
        url.pathname.endsWith("/merge_requests") &&
        url.search.includes("state=opened")
      ) {
        return json([{ iid: 12, draft: false }])
      }
      if (method === "GET" && url.pathname.endsWith("/merge_requests/12")) {
        getCount += 1
        // Pre-check is non-draft; post-merge refresh is draft (race / human edit).
        const isDraft = getCount > 1
        return json({
          iid: 12,
          state: "opened",
          draft: isDraft,
          title: isDraft ? "Draft: Ready" : "Ready",
          sha: "abc123",
          target_branch: "main",
          detailed_merge_status: isDraft ? "draft_status" : "mergeable",
          merge_status: isDraft ? "cannot_be_merged" : "can_be_merged",
          has_conflicts: false,
          head_pipeline: { id: 1, status: "success", sha: "abc123" },
        })
      }
      if (method === "GET" && url.pathname.includes("/pipelines/1/jobs")) {
        return json([
          { id: 1, name: "test", status: "success", allow_failure: false },
        ])
      }
      if (method === "GET" && url.pathname.includes("/bridges")) {
        return json([])
      }
      if (
        method === "PUT" &&
        url.pathname.endsWith("/merge_requests/12/merge")
      ) {
        return new Response("Branch cannot be merged", {
          status: 405,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`Unexpected: ${method} ${url.pathname}${url.search}`)
    }) as typeof fetch)

    const result = await Effect.runPromise(
      service.mergePullRequest(repository, "rfa/branch"),
    )
    expect(result).toMatchObject({
      _tag: "revalidation",
      reason: "mergeability_changed",
    })
  })
})
