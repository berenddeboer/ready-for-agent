import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Duration, Effect, Layer } from "effect"
import {
  GitLabProjectUnavailableError,
  GitLabRequestError,
  GitLabService,
} from "@ready-for-agent/gitlab-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import { keymaxxerGitLabLayer } from "../src/server/keymaxxer-gitlab-layer.js"
import { describe, expect, test } from "bun:test"

const platformLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
)

const repository = {
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
} as const

const vaultAccount = "git.drupalcode.org/project/oauth_client"

describe("Keymaxxer-backed GitLab layer", () => {
  test("does not prompt Keymaxxer when a repository token is missing and falls back to ambient", async () => {
    let addCalled = false
    const runs: RunWithSecretsInput[] = []
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed(null),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () =>
        Effect.sync(() => {
          addCalled = true
          return true
        }),
      runWithSecrets: (input) => {
        runs.push(input)
        return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
      },
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      environment: { GITLAB_TOKEN: "ambient-token" },
      // Ambient path is exercised via real ambient layer with env token.
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    // Without vault secret, ambient hasCredentials should be true.
    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.hasCredentials(repository)).toBe(true)
      }).pipe(Effect.provide(layer)),
    )

    expect(addCalled).toBe(false)
    expect(runs).toHaveLength(0)
  })

  test("selects vault secrets by forge-host/project-path account", async () => {
    const runs: RunWithSecretsInput[] = []
    const tokens = new Map([
      ["git.drupalcode.org/project/oauth_client", "GITLAB_TOKEN_DRUPAL_OAUTH"],
      ["gitlab.example.com/group/app", "GITLAB_TOKEN_EXAMPLE_APP"],
    ])
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: ({ account }) => Effect.succeed(tokens.get(account) ?? null),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: (input) => {
        runs.push(input)
        return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
      },
    })
    const layer = keymaxxerGitLabLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
      Layer.provide(platformLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        yield* gitlab.listReadyIssues(repository)
        yield* gitlab.listReadyIssues({
          forge: "gitlab",
          forgeHost: "gitlab.example.com",
          projectPath: "group/app",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(runs.map(({ secrets }) => secrets)).toEqual([
      ["GITLAB_TOKEN_DRUPAL_OAUTH"],
      ["GITLAB_TOKEN_EXAMPLE_APP"],
    ])
    for (const run of runs) {
      expect(run.command).toContain('GITLAB_TOKEN="$')
      expect(run.command).toMatch(/list-ready-issues/)
    }
  })

  test("vault secret takes precedence over ambient GITLAB_TOKEN", async () => {
    const runs: RunWithSecretsInput[] = []
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: ({ provider, account }) =>
        Effect.succeed(
          provider === "gitlab" && account === vaultAccount
            ? "GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"
            : null,
        ),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: (input) => {
        runs.push(input)
        return Effect.succeed({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              number: 7,
              title: "Ready issue",
              body: "Issue body",
              url: "https://git.drupalcode.org/project/oauth_client/-/issues/7",
              createdAt: "2026-07-07T12:00:00.000Z",
              state: "OPEN",
              author: "alice",
              hierarchySupported: false,
              closingPullRequests: [],
              hasChildren: false,
              parentPosition: null,
              parent: null,
              blockedBy: [],
            },
          ]),
          stderr: "",
        })
      },
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      environment: { GITLAB_TOKEN: "must-not-be-used-in-harness" },
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    const issues = await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* gitlab.listReadyIssues(repository)
      }).pipe(Effect.provide(layer)),
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]!.number).toBe(7)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.secrets).toEqual(["GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"])
    expect(runs[0]!.command).toContain(
      'GITLAB_TOKEN="$GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"',
    )
  })

  test("hasCredentials is true when vault holds the secret", async () => {
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: ({ account }) =>
        Effect.succeed(
          account === vaultAccount ? "GITLAB_TOKEN_PROJECT_OAUTH_CLIENT" : null,
        ),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: () => Effect.die("not used"),
    })
    const layer = keymaxxerGitLabLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
      Layer.provide(platformLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.hasCredentials(repository)).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("maps helper exit code 2 to project unavailable", async () => {
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed("GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: () =>
        Effect.succeed({ exitCode: 2, stdout: "", stderr: "" }),
    })
    const layer = keymaxxerGitLabLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
      Layer.provide(platformLayer),
    )

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* Effect.flip(gitlab.listReadyIssues(repository))
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(GitLabProjectUnavailableError)
  })

  test("maps helper non-zero exit to GitLabRequestError", async () => {
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed("GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: () =>
        Effect.succeed({
          exitCode: 1,
          stdout: "",
          stderr: "permission denied",
        }),
    })
    const layer = keymaxxerGitLabLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
      Layer.provide(platformLayer),
    )

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* Effect.flip(gitlab.getAuthenticatedUserLogin(repository))
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.message).toContain("permission denied")
  })

  test("hasCredentials falls through to ambient when vault lookup fails", async () => {
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () =>
        Effect.fail(keymaxxerError("findSecret", "sidecar unavailable")),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: () => Effect.die("not used"),
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      environment: { GITLAB_TOKEN: "ambient-token" },
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.hasCredentials(repository)).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("hasCredentials reaches ambient when vault findSecret hangs past budget", async () => {
    const started = Date.now()
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.never,
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: () => Effect.die("not used"),
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      environment: { GITLAB_TOKEN: "ambient-token" },
      vaultMetadataBudget: Duration.millis(40),
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.hasCredentials(repository)).toBe(true)
        // Ambient-only probe never re-enters the hung vault path.
        expect(yield* gitlab.hasAmbientCredentials(repository)).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("hasCredentials fails open when vault is unavailable and ambient is absent", async () => {
    // Vault-only repos must keep polling membership during temporary Keymaxxer
    // outages (job-worker drops schedules on false).
    let ambientChecked = false
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () =>
        Effect.fail(keymaxxerError("findSecret", "sidecar unavailable")),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: () => Effect.die("not used"),
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      // Force ambient credential probes to be a pure no (no glab/network).
      makeService: () => ({
        verifyProject: () => Effect.void,
        getAuthenticatedUserLogin: () => Effect.succeed("operator"),
        listReadyIssues: () => Effect.succeed([]),
        hasCredentials: () =>
          Effect.sync(() => {
            ambientChecked = true
            return false
          }),
        hasAmbientCredentials: () =>
          Effect.sync(() => {
            ambientChecked = true
            return false
          }),
      }),
      makeAnonymousService: () => ({
        verifyProject: () => Effect.void,
        getAuthenticatedUserLogin: () => Effect.succeed("anonymous"),
        listReadyIssues: () => Effect.succeed([]),
        hasCredentials: () => Effect.succeed(false),
        hasAmbientCredentials: () => Effect.succeed(false),
      }),
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        // Probe failure is not a clean miss: treat as still credentialed and
        // do not consult ambient for membership (fail open).
        expect(yield* gitlab.hasCredentials(repository)).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
    expect(ambientChecked).toBe(false)
  })

  test("listReadyIssues reaches ambient when vault findSecret hangs past budget", async () => {
    const runs: RunWithSecretsInput[] = []
    let ambientListCalls = 0
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.never,
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: (input) => {
        runs.push(input)
        return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
      },
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      environment: { GITLAB_TOKEN: "ambient-token" },
      vaultMetadataBudget: Duration.millis(40),
      makeService: () => ({
        verifyProject: () => Effect.void,
        getAuthenticatedUserLogin: () => Effect.succeed("operator"),
        listReadyIssues: () => {
          ambientListCalls += 1
          return Effect.succeed([])
        },
        hasCredentials: () => Effect.succeed(true),
        hasAmbientCredentials: () => Effect.succeed(true),
      }),
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    const started = Date.now()
    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.listReadyIssues(repository)).toEqual([])
      }).pipe(Effect.provide(layer)),
    )
    expect(runs).toHaveLength(0)
    expect(ambientListCalls).toBe(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("operations fall through to ambient when vault lookup fails", async () => {
    const runs: RunWithSecretsInput[] = []
    let ambientListCalls = 0
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () =>
        Effect.fail(keymaxxerError("findSecret", "sidecar unavailable")),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: (input) => {
        runs.push(input)
        return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
      },
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      environment: { GITLAB_TOKEN: "ambient-token" },
      makeService: () => ({
        verifyProject: () => Effect.void,
        getAuthenticatedUserLogin: () => Effect.succeed("operator"),
        listReadyIssues: () => {
          ambientListCalls += 1
          return Effect.succeed([])
        },
        hasCredentials: () => Effect.succeed(true),
        hasAmbientCredentials: () => Effect.succeed(true),
      }),
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.listReadyIssues(repository)).toEqual([])
      }).pipe(Effect.provide(layer)),
    )
    expect(runs).toHaveLength(0)
    expect(ambientListCalls).toBe(1)
  })

  test("helper KeymaxxerError after a resolved secret stays fail-closed", async () => {
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed("GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: () =>
        Effect.fail(keymaxxerError("runWithSecrets", "use denied")),
    })
    const layer = keymaxxerGitLabLayer({
      workspaceRoot: "/workspace",
      environment: { GITLAB_TOKEN: "must-not-fallback" },
    }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* Effect.flip(gitlab.listReadyIssues(repository))
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(GitLabRequestError)
    expect(error.message).toContain("list Ready-labeled Issues")
  })
})
