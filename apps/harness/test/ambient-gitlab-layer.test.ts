import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
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
  forge: "gitlab" as const,
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
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded",
      terminalChecks: [],
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
    }),
  getPrStatusCheckDiagnostics: () => Effect.succeed([]),
  markPullRequestReadyForReview: () => Effect.void,
  getPullRequestLifecycleStatus: () =>
    Effect.succeed({ _tag: "open" as const }),
  mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
  ensureIssueCompletedWithSummary: () => Effect.void,
  closeOpenPullRequestsForBranch: () => Effect.void,
  deleteBranch: () => Effect.void,
  ...overrides,
})

/**
 * Simulates glab CLI for ambient credential resolution via
 * `glab auth status --hostname <host> --show-token`.
 *
 * Hosts in `hostTokens` emit an unmasked Token found line (optionally with a
 * non-zero exit code to simulate API outage). Other hosts emit the unconfigured
 * host error with no token.
 */
const glabProcessLayer = (options: {
  readonly hostTokens: ReadonlyMap<string, string>
  /** Exit code for authenticated hosts (1 simulates API failure with token). */
  readonly authenticatedExitCode?: number
}) => {
  const commands: Array<ReadonlyArray<string>> = []
  const encoder = new TextEncoder()

  const service = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) {
        throw new Error("expected standard command")
      }
      const args = [command.command, ...command.args]
      commands.push(args)
      const hostIndex = command.args.indexOf("--hostname")
      const host = hostIndex >= 0 ? (command.args[hostIndex + 1] ?? "") : ""
      const token = options.hostTokens.get(host)
      const showToken = command.args.includes("--show-token")
      const body =
        token === undefined || !showToken
          ? `X ${host} has not been authenticated with glab\n`
          : `${host}\n  x API call failed\n  ✓ Token found: ${token}\nERROR\nX could not authenticate\n`
      const bytes = encoder.encode(body)
      const exitCode = ChildProcessSpawner.ExitCode(
        token === undefined ? 1 : (options.authenticatedExitCode ?? 0),
      )
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(exitCode),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: {
          onStart: () => Effect.void,
          onInput: () => Effect.void,
          onEnd: () => Effect.void,
        } as never,
        stdout: Stream.succeed(bytes),
        stderr: Stream.empty,
        all: Stream.succeed(bytes),
        getInputFd: () =>
          ({
            onStart: () => Effect.void,
            onInput: () => Effect.void,
            onEnd: () => Effect.void,
          }) as never,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )

  return {
    commands,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
  }
}

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

test("glab login for a host is recognized for that host only", async () => {
  const glab = glabProcessLayer({
    hostTokens: new Map([["git.drupalcode.org", "token-for-drupalcode"]]),
    // Non-zero exit with Token found simulates API outage resilience.
    authenticatedExitCode: 1,
  })
  const tokens: string[] = []
  const layer = ambientGitLabLayer({
    workspaceRoot: "/workspace",
    makeService: (token) => {
      tokens.push(token)
      return service()
    },
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const gitlab = yield* GitLabService
      const configured = yield* gitlab.hasCredentials(repository)
      const wrongSshHost = yield* gitlab.hasCredentials({
        ...repository,
        forgeHost: "git.drupal.org",
      })
      const arbitrary = yield* gitlab.hasCredentials({
        ...repository,
        forgeHost: "not-a-real-host.example",
      })
      const ambientConfigured = yield* gitlab.hasAmbientCredentials(repository)
      const ambientWrong = yield* gitlab.hasAmbientCredentials({
        ...repository,
        forgeHost: "git.drupal.org",
      })
      yield* gitlab.listReadyIssues(repository)
      return {
        configured,
        wrongSshHost,
        arbitrary,
        ambientConfigured,
        ambientWrong,
      }
    }).pipe(Effect.provide(layer.pipe(Layer.provide(glab.layer)))),
  )

  expect(result).toEqual({
    configured: true,
    wrongSshHost: false,
    arbitrary: false,
    ambientConfigured: true,
    ambientWrong: false,
  })
  expect(tokens).toEqual(["token-for-drupalcode"])
  expect(
    glab.commands.some(
      (args) =>
        args[0] === "glab" &&
        args[1] === "auth" &&
        args[2] === "status" &&
        args[3] === "--hostname" &&
        args[4] === "git.drupalcode.org" &&
        args.includes("--show-token"),
    ),
  ).toBe(true)
  expect(
    glab.commands.some(
      (args) =>
        args[0] === "glab" &&
        args[1] === "auth" &&
        args[2] === "status" &&
        args[3] === "--hostname" &&
        args[4] === "not-a-real-host.example",
    ),
  ).toBe(true)
  // Shared helper never uses config-get (fallback-token path).
  expect(
    glab.commands.some(
      (args) =>
        args[0] === "glab" &&
        args[1] === "config" &&
        args[2] === "get" &&
        args[3] === "token",
    ),
  ).toBe(false)
})

test("unconfigured hosts do not receive credentials from glab", async () => {
  const glab = glabProcessLayer({
    hostTokens: new Map(),
  })
  const tokens: string[] = []
  const layer = ambientGitLabLayer({
    workspaceRoot: "/workspace",
    makeService: (token) => {
      tokens.push(token)
      return service()
    },
  })

  const hasCredentials = await Effect.runPromise(
    Effect.gen(function* () {
      const gitlab = yield* GitLabService
      return yield* gitlab.hasCredentials({
        ...repository,
        forgeHost: "not-a-real-host.example",
      })
    }).pipe(Effect.provide(layer.pipe(Layer.provide(glab.layer)))),
  )

  expect(hasCredentials).toBe(false)
  expect(tokens).toEqual([])
})

test("GITLAB_TOKEN still takes precedence over host-specific glab auth", async () => {
  const glab = glabProcessLayer({
    hostTokens: new Map([["git.drupalcode.org", "glab-token"]]),
  })
  const tokens: string[] = []
  const layer = ambientGitLabLayer({
    workspaceRoot: "/workspace",
    environment: { GITLAB_TOKEN: " env-token " },
    makeService: (token) => {
      tokens.push(token)
      return service()
    },
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const gitlab = yield* GitLabService
      expect(yield* gitlab.hasCredentials(repository)).toBe(true)
      expect(
        yield* gitlab.hasCredentials({
          ...repository,
          forgeHost: "not-a-real-host.example",
        }),
      ).toBe(true)
      yield* gitlab.listReadyIssues(repository)
    }).pipe(Effect.provide(layer.pipe(Layer.provide(glab.layer)))),
  )

  expect(tokens).toEqual(["env-token"])
  // Env token short-circuits; glab must not be consulted.
  expect(glab.commands).toEqual([])
})
