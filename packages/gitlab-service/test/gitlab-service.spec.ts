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
  (async (input) => {
    const url = new URL(String(input))
    const response = responses[`${url.pathname}${url.search}`]
    if (response === undefined) {
      throw new Error(`Unexpected request: ${url.pathname}${url.search}`)
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
