import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer } from "effect"
import {
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import { ambientGitHubLayer } from "../src/server/ambient-github-layer.js"
import { expect, test } from "bun:test"

const processLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
)

const serviceWithList = (
  listReadyIssues: GitHubServiceShape["listReadyIssues"],
): GitHubServiceShape => ({
  listReadyIssues,
  getAuthenticatedUserLogin: () => Effect.die("not used"),
  getOpenPullRequestNumber: () => Effect.die("not used"),
  getPullRequestCheckStatus: () => Effect.die("not used"),
  getPrStatusCheckDiagnostics: () => Effect.die("not used"),
  getPullRequestLifecycleStatus: () => Effect.die("not used"),
  markPullRequestReadyForReview: () => Effect.die("not used"),
  mergePullRequest: () => Effect.die("not used"),
  rerunWorkflowRun: () => Effect.void,
  ensureIssueCompletedWithSummary: () => Effect.die("not used"),
})

test("ambient GitHub authentication is resolved once", async () => {
  let resolutions = 0
  const tokens: string[] = []
  const layer = ambientGitHubLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => {
      resolutions += 1
      return "cached-token"
    },
    makeService: (token) => {
      tokens.push(token)
      return serviceWithList(() => Effect.succeed([]))
    },
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubService
      yield* github.listReadyIssues({ owner: "acme", name: "one" })
      yield* github.listReadyIssues({ owner: "acme", name: "two" })
    }).pipe(Effect.provide(layer), Effect.provide(processLayer)),
  )

  expect(resolutions).toBe(1)
  expect(tokens).toEqual(["cached-token", "cached-token"])
})

test("ambient GitHub authentication refreshes once after a 401", async () => {
  const resolvedTokens = ["expired-token", "fresh-token"]
  let resolutions = 0
  const layer = ambientGitHubLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => resolvedTokens[resolutions++]!,
    makeService: (token) =>
      serviceWithList(() =>
        token === "expired-token"
          ? Effect.fail(
              new GitHubRequestError({
                message: "Unauthorized",
                statusCode: 401,
              }),
            )
          : Effect.succeed([]),
      ),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubService
      yield* github.listReadyIssues({ owner: "acme", name: "widgets" })
    }).pipe(Effect.provide(layer), Effect.provide(processLayer)),
  )

  expect(resolutions).toBe(2)
})

test("concurrent 401 responses share one refreshed token", async () => {
  const resolvedTokens = ["expired-token", "fresh-token"]
  let resolutions = 0
  let expiredCalls = 0
  let releaseExpiredCalls: () => void = () => undefined
  const bothExpiredCallsStarted = new Promise<void>((resolve) => {
    releaseExpiredCalls = resolve
  })
  const layer = ambientGitHubLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => resolvedTokens[resolutions++]!,
    makeService: (token) =>
      serviceWithList(() => {
        if (token === "fresh-token") return Effect.succeed([])
        return Effect.tryPromise({
          try: async () => {
            expiredCalls += 1
            if (expiredCalls === 2) releaseExpiredCalls()
            await bothExpiredCallsStarted
            throw new GitHubRequestError({
              message: "Unauthorized",
              statusCode: 401,
            })
          },
          catch: (error) => error as GitHubRequestError,
        })
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubService
      yield* Effect.all(
        [
          github.listReadyIssues({ owner: "acme", name: "one" }),
          github.listReadyIssues({ owner: "acme", name: "two" }),
        ],
        { concurrency: "unbounded" },
      )
    }).pipe(Effect.provide(layer), Effect.provide(processLayer)),
  )

  expect(expiredCalls).toBe(2)
  expect(resolutions).toBe(2)
})

test("ambient GitHub authentication is not refreshed after a 403", async () => {
  let resolutions = 0
  const layer = ambientGitHubLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => {
      resolutions += 1
      return "insufficient-token"
    },
    makeService: () =>
      serviceWithList(() =>
        Effect.fail(
          new GitHubRequestError({
            message: "Forbidden",
            statusCode: 403,
          }),
        ),
      ),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubService
      return yield* Effect.exit(
        github.listReadyIssues({ owner: "acme", name: "widgets" }),
      )
    }).pipe(Effect.provide(layer), Effect.provide(processLayer)),
  )

  expect(resolutions).toBe(1)
})

test("failed authentication acquisition is cleared for a later retry", async () => {
  let resolutions = 0
  const layer = ambientGitHubLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => {
      resolutions += 1
      if (resolutions === 1) throw new Error("gh unavailable")
      return "recovered-token"
    },
    makeService: () => serviceWithList(() => Effect.succeed([])),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubService
      const first = yield* Effect.exit(
        github.listReadyIssues({ owner: "acme", name: "widgets" }),
      )
      expect(first._tag).toBe("Failure")
      yield* github.listReadyIssues({ owner: "acme", name: "widgets" })
    }).pipe(Effect.provide(layer), Effect.provide(processLayer)),
  )

  expect(resolutions).toBe(2)
})
