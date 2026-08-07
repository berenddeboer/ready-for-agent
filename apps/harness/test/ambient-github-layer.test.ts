import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import { ambientGitHubLayer as makeAmbientGitHubLayer } from "../src/server/ambient-github-layer.js"
import { GitHubOperationCoordinatorLive } from "../src/server/github-operation-coordinator.js"

const ambientGitHubLayer = (
  options: Parameters<typeof makeAmbientGitHubLayer>[0],
) =>
  makeAmbientGitHubLayer(options).pipe(
    Layer.provide(GitHubOperationCoordinatorLive),
  )

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

const serviceWithAuthenticatedUser = (
  getAuthenticatedUserLogin: GitHubServiceShape["getAuthenticatedUserLogin"],
  listReadyIssues: GitHubServiceShape["listReadyIssues"] = () =>
    Effect.succeed([]),
): GitHubServiceShape => ({
  ...serviceWithList(listReadyIssues),
  getAuthenticatedUserLogin,
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

it.effect("ambient GitHub authentication is resolved once", () =>
  Effect.gen(function* () {
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

    yield* Effect.gen(function* () {
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
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer))))

    expect(resolutions).toBe(1)
    expect(tokens).toEqual(["cached-token", "cached-token"])
  }),
)

it.effect(
  "caches ambient authenticated logins per Repository credential path",
  () =>
    Effect.gen(function* () {
      let identityLookups = 0
      const layer = ambientGitHubLayer({
        workspaceRoot: "/workspace",
        resolveToken: async () => "cached-token",
        makeService: () =>
          serviceWithAuthenticatedUser(({ projectPath }) =>
            Effect.sync(() => {
              identityLookups += 1
              return projectPath
            }),
          ),
      })

      yield* Effect.gen(function* () {
        const github = yield* GitHubService
        expect(yield* github.getAuthenticatedUserLogin(repository)).toBe(
          "acme/widgets",
        )
        expect(
          yield* github.getAuthenticatedUserLogin({
            ...repository,
            projectPath: "acme/gadgets",
          }),
        ).toBe("acme/gadgets")
        expect(yield* github.getAuthenticatedUserLogin(repository)).toBe(
          "acme/widgets",
        )
      }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer))))

      expect(identityLookups).toBe(2)
    }),
)

it.effect("shares concurrent ambient authenticated identity lookups", () =>
  Effect.gen(function* () {
    const identityStarted = yield* Deferred.make<void>()
    const releaseIdentity = yield* Deferred.make<void>()
    let identityLookups = 0
    const layer = ambientGitHubLayer({
      workspaceRoot: "/workspace",
      resolveToken: async () => "cached-token",
      makeService: () =>
        serviceWithAuthenticatedUser(() =>
          Effect.gen(function* () {
            identityLookups += 1
            yield* Deferred.succeed(identityStarted, undefined)
            yield* Deferred.await(releaseIdentity)
            return "operator"
          }),
        ),
    })

    yield* Effect.gen(function* () {
      const github = yield* GitHubService
      const first = yield* github
        .getAuthenticatedUserLogin(repository)
        .pipe(Effect.forkChild)
      const second = yield* github
        .getAuthenticatedUserLogin(repository)
        .pipe(Effect.forkChild)
      yield* Deferred.await(identityStarted)
      expect(identityLookups).toBe(1)
      yield* Deferred.succeed(releaseIdentity, undefined)
      expect(yield* Fiber.join(first)).toBe("operator")
      expect(yield* Fiber.join(second)).toBe("operator")
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer))))
  }),
)

it.effect(
  "ambient authentication refresh invalidates cached logins for every Repository",
  () =>
    Effect.gen(function* () {
      const tokens = ["expired-token", "fresh-token"]
      let tokenIndex = 0
      const layer = ambientGitHubLayer({
        workspaceRoot: "/workspace",
        resolveToken: async () => tokens[tokenIndex++]!,
        makeService: (token) =>
          serviceWithAuthenticatedUser(
            () => Effect.succeed(token === "expired-token" ? "old" : "new"),
            () =>
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

      yield* Effect.gen(function* () {
        const github = yield* GitHubService
        expect(yield* github.getAuthenticatedUserLogin(repository)).toBe("old")
        const otherRepository = {
          ...repository,
          projectPath: "acme/gadgets",
        }
        expect(yield* github.getAuthenticatedUserLogin(otherRepository)).toBe(
          "old",
        )
        expect(yield* github.listReadyIssues(otherRepository)).toEqual([])
        expect(yield* github.getAuthenticatedUserLogin(repository)).toBe("new")
      }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer))))

      expect(tokenIndex).toBe(2)
    }),
)

it.effect("ambient GitHub authentication refreshes once after a 401", () =>
  Effect.gen(function* () {
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

    yield* Effect.gen(function* () {
      const github = yield* GitHubService
      yield* github.listReadyIssues({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
      })
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer))))

    expect(resolutions).toBe(2)
  }),
)

it("application scope interrupts in-flight ambient authentication", async () => {
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

it("canceling the first requester keeps shared authentication alive", async () => {
  // Cache.get is forked into the layer scope: canceling one requester only
  // drops its Fiber.join, while the shared lookup continues for joiners.
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
  const second = runtime.runPromise(listReadyIssues)
  process.complete("shared-token")

  try {
    expect(await second).toEqual([])
    await first
    expect(process.startCount()).toBe(1)
    expect(process.interrupted()).toBe(0)
  } finally {
    await runtime.dispose()
  }
})

it("concurrent joiners survive cancel of the cache owner fiber", async () => {
  const process = controlledTokenProcess()
  const runtime = ManagedRuntime.make(
    ambientGitHubLayer({
      workspaceRoot: "/workspace",
      makeService: () => serviceWithList(() => Effect.succeed([])),
    }).pipe(Layer.provide(process.layer)),
  )
  await runtime.context()
  const ownerController = new AbortController()
  const owner = runtime
    .runPromise(listReadyIssues, { signal: ownerController.signal })
    .catch(() => undefined)
  const joiner = runtime.runPromise(listReadyIssues)

  await process.started
  ownerController.abort()
  process.complete("shared-token")

  try {
    expect(await joiner).toEqual([])
    await owner
    expect(process.startCount()).toBe(1)
    expect(process.interrupted()).toBe(0)
  } finally {
    await runtime.dispose()
  }
})

it("serialized ambient operations share a 401 token refresh", async () => {
  const resolvedTokens = ["expired-token", "fresh-token"]
  let resolutions = 0
  let expiredCalls = 0
  const layer = ambientGitHubLayer({
    workspaceRoot: "/workspace",
    resolveToken: async () => resolvedTokens[resolutions++]!,
    makeService: (token) =>
      serviceWithList(() => {
        if (token === "fresh-token") return Effect.succeed([])
        expiredCalls += 1
        return Effect.fail(
          new GitHubRequestError({
            message: "Unauthorized",
            statusCode: 401,
          }),
        )
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

  expect(expiredCalls).toBe(1)
  expect(resolutions).toBe(2)
})

it.effect("ambient GitHub authentication is not refreshed after a 403", () =>
  Effect.gen(function* () {
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

    yield* Effect.gen(function* () {
      const github = yield* GitHubService
      return yield* Effect.exit(
        github.listReadyIssues({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
        }),
      )
    }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer))))

    expect(resolutions).toBe(1)
  }),
)

it.effect(
  "failed authentication acquisition is cleared for a later retry",
  () =>
    Effect.gen(function* () {
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

      yield* Effect.gen(function* () {
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
      }).pipe(Effect.provide(layer.pipe(Layer.provide(processLayer))))

      expect(resolutions).toBe(2)
    }),
)
