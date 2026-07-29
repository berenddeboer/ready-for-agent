import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer } from "effect"
import {
  GitLabRequestError,
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import { ambientGitLabLayer } from "../src/server/ambient-gitlab-layer.js"
import { expect, test } from "bun:test"

const processLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
)

const repository = {
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
}

const service = (
  overrides: Partial<GitLabServiceShape> = {},
): GitLabServiceShape => ({
  verifyProject: () => Effect.void,
  getAuthenticatedUserLogin: () => Effect.succeed("operator"),
  listReadyIssues: () => Effect.succeed([]),
  hasCredentials: () => Effect.succeed(true),
  hasAmbientCredentials: () => Effect.succeed(true),
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(null),
  createDraftPullRequest: () => Effect.succeed(1),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  ensureIssueCompletedWithSummary: () => Effect.void,
  closeOpenPullRequestsForBranch: () => Effect.void,
  deleteBranch: () => Effect.void,
  ...overrides,
})

test("GITLAB_TOKEN takes precedence over glab and is cached per host", async () => {
  let resolutions = 0
  const tokens: string[] = []
  const layer = ambientGitLabLayer({
    workspaceRoot: "/workspace",
    environment: { GITLAB_TOKEN: " environment-token " },
    resolveToken: async () => {
      resolutions += 1
      return "glab-token"
    },
    makeService: (token) => {
      tokens.push(token)
      return service()
    },
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const gitlab = yield* GitLabService
      yield* gitlab.listReadyIssues(repository)
      yield* gitlab.getAuthenticatedUserLogin({
        ...repository,
        projectPath: "project/other",
      })
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
  )

  expect(resolutions).toBe(0)
  expect(tokens).toEqual(["environment-token", "environment-token"])
})

test("glab tokens are resolved independently per GitLab host", async () => {
  const hosts: string[] = []
  const layer = ambientGitLabLayer({
    workspaceRoot: "/workspace",
    resolveToken: async (host) => {
      hosts.push(host)
      return `token-for-${host}`
    },
    makeService: () => service(),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const gitlab = yield* GitLabService
      yield* gitlab.listReadyIssues(repository)
      yield* gitlab.listReadyIssues({
        ...repository,
        forgeHost: "gitlab.example.com",
      })
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
  )

  expect(hosts).toEqual(["git.drupalcode.org", "gitlab.example.com"])
})

test("authentication refreshes once after a GitLab 401", async () => {
  const resolvedTokens = ["expired", "fresh"]
  let resolutions = 0
  const layer = ambientGitLabLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => resolvedTokens[resolutions++]!,
    makeService: (token) =>
      service({
        listReadyIssues: () =>
          token === "expired"
            ? Effect.fail(
                new GitLabRequestError({
                  message: "Unauthorized",
                  statusCode: 401,
                }),
              )
            : Effect.succeed([]),
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const gitlab = yield* GitLabService
      yield* gitlab.listReadyIssues(repository)
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
  )

  expect(resolutions).toBe(2)
})

test("public project verification falls back to anonymous access", async () => {
  let anonymousVerifications = 0
  const layer = ambientGitLabLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => {
      throw new Error("glab is not authenticated")
    },
    makeAnonymousService: () =>
      service({
        verifyProject: () => {
          anonymousVerifications += 1
          return Effect.void
        },
        hasCredentials: () => Effect.succeed(false),
        hasAmbientCredentials: () => Effect.succeed(false),
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const gitlab = yield* GitLabService
      expect(yield* gitlab.hasCredentials(repository)).toBe(false)
      yield* gitlab.verifyProject(repository)
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
  )

  expect(anonymousVerifications).toBe(1)
})
