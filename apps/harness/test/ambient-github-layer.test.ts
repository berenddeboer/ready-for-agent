import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
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

const repository = {
  forge: "github" as const,
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}

const serviceWithList = (
  listReadyIssues: GitHubServiceShape["listReadyIssues"],
): GitHubServiceShape => ({
  listReadyIssues,
  getAuthenticatedUserLogin: () => Effect.die("not used"),
  getOpenPullRequestNumber: () => Effect.die("not used"),
  findOpenPullRequestNumber: () => Effect.die("not used"),
  createDraftPullRequest: () => Effect.die("not used"),
  updateOpenDraftPullRequestCopy: () => Effect.die("not used"),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () => Effect.die("not used"),
  getPrStatusCheckDiagnostics: () => Effect.die("not used"),
  observeAutomatedReviewEvidence: () =>
    Effect.succeed({
      _tag: "ambiguous" as const,
      reason: "Automated review evidence observation is not configured",
    }),
  getPullRequestLifecycleStatus: () => Effect.die("not used"),
  markPullRequestReadyForReview: () => Effect.die("not used"),
  mergePullRequest: () => Effect.die("not used"),
  rerunWorkflowRun: () => Effect.void,
  ensureIssueCompletedWithSummary: () => Effect.die("not used"),
})

const controlledTokenProcess = () => {
  let complete: (token: string) => void = () => undefined
  let interruptCount = 0
  let startCount = 0
  let started: () => void = () => undefined
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const string = () => {
    return Effect.callback<string>((resume) => {
      startCount += 1
      started()
      complete = (token) => resume(Effect.succeed(token))
      return Effect.sync(() => {
        interruptCount += 1
      })
    })
  }
  const service = ChildProcessSpawner.ChildProcessSpawner.of({
    spawn: () => Effect.never,
    exitCode: () => Effect.never,
    streamString: () => Stream.never,
    streamLines: () => Stream.never,
    lines: () => Effect.never,
    string,
  })

  return {
    complete: (token: string) => complete(token),
    interrupted: () => interruptCount,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
    startCount: () => startCount,
    started: start,
  }
}

const listReadyIssues = Effect.gen(function* () {
  const github = yield* GitHubService
  return yield* github.listReadyIssues(repository)
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
      yield* github.listReadyIssues({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/one",
      })
      yield* github.listReadyIssues({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/two",
      })
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
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
      yield* github.listReadyIssues({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
      })
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
  )

  expect(resolutions).toBe(2)
})

test("application scope interrupts in-flight ambient authentication", async () => {
  const process = controlledTokenProcess()
  const runtime = ManagedRuntime.make(
    ambientGitHubLayer({
      workspaceRoot: "/workspace",
      makeService: () => serviceWithList(() => Effect.succeed([])),
    }).pipe(Layer.provide(process.layer)),
  )
  await runtime.context()
  const pending = runtime.runPromise(listReadyIssues).catch(() => undefined)

  await process.started
  try {
    await runtime.dispose()
    await pending
    expect(process.interrupted()).toBe(1)
  } finally {
    process.complete("late-token")
  }
})

test("canceling the first requester keeps shared authentication alive", async () => {
  const process = controlledTokenProcess()
  const runtime = ManagedRuntime.make(
    ambientGitHubLayer({
      workspaceRoot: "/workspace",
      makeService: () => serviceWithList(() => Effect.succeed([])),
    }).pipe(Layer.provide(process.layer)),
  )
  await runtime.context()
  const controller = new AbortController()
  const first = runtime
    .runPromise(listReadyIssues, { signal: controller.signal })
    .catch(() => undefined)

  await process.started
  controller.abort()
  await first
  const second = runtime.runPromise(listReadyIssues)
  process.complete("shared-token")

  try {
    expect(await second).toEqual([])
    expect(process.startCount()).toBe(1)
    expect(process.interrupted()).toBe(0)
  } finally {
    await runtime.dispose()
  }
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
          github.listReadyIssues({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/one",
          }),
          github.listReadyIssues({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/two",
          }),
        ],
        { concurrency: "unbounded" },
      )
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
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
        github.listReadyIssues({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        }),
      )
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
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
        github.listReadyIssues({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        }),
      )
      expect(first._tag).toBe("Failure")
      yield* github.listReadyIssues({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
      })
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer)))),
  )

  expect(resolutions).toBe(2)
})
