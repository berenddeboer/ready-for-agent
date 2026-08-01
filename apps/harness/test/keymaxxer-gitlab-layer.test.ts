import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
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

const platformLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
)

const gitlabLifecycleStub = {
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(null),
  createDraftPullRequest: () => Effect.succeed(1),
  updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded" as const,
      terminalChecks: [],
      mergeability: "mergeable" as const,
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
} as const

const repository = {
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
} as const

const vaultAccount = "git.drupalcode.org/project/oauth_client"

describe("Keymaxxer-backed GitLab layer", () => {
  it.effect(
    "does not prompt Keymaxxer when a repository token is missing and falls back to ambient",
    () =>
      Effect.gen(function* () {
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
        yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          expect(yield* gitlab.hasCredentials(repository)).toBe(true)
        }).pipe(Effect.provide(layer))

        expect(addCalled).toBe(false)
        expect(runs).toHaveLength(0)
      }),
  )

  it.effect("selects vault secrets by forge-host/project-path account", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const tokens = new Map([
        [
          "git.drupalcode.org/project/oauth_client",
          "GITLAB_TOKEN_DRUPAL_OAUTH",
        ],
        ["gitlab.example.com/group/app", "GITLAB_TOKEN_EXAMPLE_APP"],
      ])
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(tokens.get(account) ?? null),
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

      yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        yield* gitlab.listReadyIssues(repository)
        yield* gitlab.listReadyIssues({
          forge: "gitlab",
          forgeHost: "gitlab.example.com",
          projectPath: "group/app",
        })
      }).pipe(Effect.provide(layer))

      expect(runs.map(({ secrets }) => secrets)).toEqual([
        ["GITLAB_TOKEN_DRUPAL_OAUTH"],
        ["GITLAB_TOKEN_EXAMPLE_APP"],
      ])
      for (const run of runs) {
        expect(run.command).toContain('GITLAB_TOKEN="$')
        expect(run.command).toMatch(/list-ready-issues/)
      }
    }),
  )

  it.effect("vault secret takes precedence over ambient GITLAB_TOKEN", () =>
    Effect.gen(function* () {
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

      const issues = yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* gitlab.listReadyIssues(repository)
      }).pipe(Effect.provide(layer))

      expect(issues).toHaveLength(1)
      expect(issues[0]!.number).toBe(7)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.secrets).toEqual(["GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"])
      expect(runs[0]!.command).toContain(
        'GITLAB_TOKEN="$GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"',
      )
    }),
  )

  it.effect("hasCredentials is true when vault holds the secret", () =>
    Effect.gen(function* () {
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(
            account === vaultAccount
              ? "GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"
              : null,
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

      yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.hasCredentials(repository)).toBe(true)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("maps helper exit code 2 to project unavailable", () =>
    Effect.gen(function* () {
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

      const error = yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* Effect.flip(gitlab.listReadyIssues(repository))
      }).pipe(Effect.provide(layer))

      expect(error).toBeInstanceOf(GitLabProjectUnavailableError)
    }),
  )

  it.effect(
    "verifyProject decodes JSON host rewrite from the vault helper",
    () =>
      Effect.gen(function* () {
        const sshGuess = {
          forge: "gitlab",
          forgeHost: "git.drupal.org",
          projectPath: "project/oauth_client",
        } as const
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: ({ account }) =>
            Effect.succeed(
              account === "git.drupal.org/project/oauth_client"
                ? "GITLAB_TOKEN_SSH_GUESS"
                : null,
            ),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.succeed({
              exitCode: 0,
              stdout: JSON.stringify({
                forge: "gitlab",
                forgeHost: "Git.DrupalCode.Org",
                projectPath: "project/oauth_client",
              }),
              stderr: "",
            }),
        })
        const layer = keymaxxerGitLabLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const resolved = yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          return yield* gitlab.verifyProject(sshGuess)
        }).pipe(Effect.provide(layer))

        expect(resolved).toEqual({
          forge: "gitlab",
          forgeHost: "git.drupalcode.org",
          projectPath: "project/oauth_client",
        })
      }),
  )

  it.effect(
    "verifyProject treats legacy ok helper stdout as no host change",
    () =>
      Effect.gen(function* () {
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" }),
        })
        const layer = keymaxxerGitLabLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const resolved = yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          return yield* gitlab.verifyProject(repository)
        }).pipe(Effect.provide(layer))

        expect(resolved).toEqual(repository)
      }),
  )

  it.effect(
    "verifyProject maps invalid helper JSON to GitLabRequestError",
    () =>
      Effect.gen(function* () {
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.succeed({
              exitCode: 0,
              stdout: "not-json",
              stderr: "",
            }),
        })
        const layer = keymaxxerGitLabLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const error = yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          return yield* Effect.flip(gitlab.verifyProject(repository))
        }).pipe(Effect.provide(layer))

        expect(error).toBeInstanceOf(GitLabRequestError)
      }),
  )

  it.effect("maps helper non-zero exit to GitLabRequestError", () =>
    Effect.gen(function* () {
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

      const error = yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* Effect.flip(gitlab.getAuthenticatedUserLogin(repository))
      }).pipe(Effect.provide(layer))

      expect(error).toBeInstanceOf(GitLabRequestError)
      expect(error.message).toContain("permission denied")
    }),
  )

  it.effect(
    "hasCredentials falls through to ambient when vault lookup fails",
    () =>
      Effect.gen(function* () {
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

        yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          expect(yield* gitlab.hasCredentials(repository)).toBe(true)
        }).pipe(Effect.provide(layer))
      }),
  )

  // Real wall-clock budget: vault findSecret hangs until Duration elapses.
  it.live(
    "hasCredentials reaches ambient when vault findSecret hangs past budget",
    () =>
      Effect.gen(function* () {
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

        yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          expect(yield* gitlab.hasCredentials(repository)).toBe(true)
          // Ambient-only probe never re-enters the hung vault path.
          expect(yield* gitlab.hasAmbientCredentials(repository)).toBe(true)
        }).pipe(Effect.provide(layer))
        expect(Date.now() - started).toBeLessThan(2_000)
      }),
  )

  it.effect(
    "hasCredentials fails open when vault is unavailable and ambient is absent",
    () =>
      Effect.gen(function* () {
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
            verifyProject: (repository) => Effect.succeed(repository),
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
            ...gitlabLifecycleStub,
          }),
          makeAnonymousService: () => ({
            verifyProject: (repository) => Effect.succeed(repository),
            getAuthenticatedUserLogin: () => Effect.succeed("anonymous"),
            listReadyIssues: () => Effect.succeed([]),
            hasCredentials: () => Effect.succeed(false),
            hasAmbientCredentials: () => Effect.succeed(false),
            ...gitlabLifecycleStub,
          }),
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          // Probe failure is not a clean miss: treat as still credentialed and
          // do not consult ambient for membership (fail open).
          expect(yield* gitlab.hasCredentials(repository)).toBe(true)
        }).pipe(Effect.provide(layer))
        expect(ambientChecked).toBe(false)
      }),
  )

  // Real wall-clock budget: vault findSecret hangs until Duration elapses.
  it.live(
    "listReadyIssues reaches ambient when vault findSecret hangs past budget",
    () =>
      Effect.gen(function* () {
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
            verifyProject: (repository) => Effect.succeed(repository),
            getAuthenticatedUserLogin: () => Effect.succeed("operator"),
            listReadyIssues: () => {
              ambientListCalls += 1
              return Effect.succeed([])
            },
            hasCredentials: () => Effect.succeed(true),
            hasAmbientCredentials: () => Effect.succeed(true),
            ...gitlabLifecycleStub,
          }),
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const started = Date.now()
        yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          expect(yield* gitlab.listReadyIssues(repository)).toEqual([])
        }).pipe(Effect.provide(layer))
        expect(runs).toHaveLength(0)
        expect(ambientListCalls).toBe(1)
        expect(Date.now() - started).toBeLessThan(2_000)
      }),
  )

  it.effect("operations fall through to ambient when vault lookup fails", () =>
    Effect.gen(function* () {
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
          verifyProject: (repository) => Effect.succeed(repository),
          getAuthenticatedUserLogin: () => Effect.succeed("operator"),
          listReadyIssues: () => {
            ambientListCalls += 1
            return Effect.succeed([])
          },
          hasCredentials: () => Effect.succeed(true),
          hasAmbientCredentials: () => Effect.succeed(true),
          ...gitlabLifecycleStub,
        }),
      }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

      yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        expect(yield* gitlab.listReadyIssues(repository)).toEqual([])
      }).pipe(Effect.provide(layer))
      expect(runs).toHaveLength(0)
      expect(ambientListCalls).toBe(1)
    }),
  )

  it.effect(
    "helper KeymaxxerError after a resolved secret stays fail-closed",
    () =>
      Effect.gen(function* () {
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

        const error = yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          return yield* Effect.flip(gitlab.listReadyIssues(repository))
        }).pipe(Effect.provide(layer))

        expect(error).toBeInstanceOf(GitLabRequestError)
        expect(error.message).toContain("list Ready-labeled Issues")
      }),
  )

  it.effect(
    "checks a merge-request branch through the vault secret and rehydrates dates",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: ({ account }) =>
            Effect.succeed(
              account === vaultAccount
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
              stdout: JSON.stringify({
                _tag: "failed",
                mergeability: "mergeable",
                baseRefName: "1.0.x",
                headPushedAt: "2026-07-20T10:04:00.000Z",
                headSha: "deadbeef",
                createdAt: "2026-07-20T10:00:00.000Z",
                isDraft: true,
                terminalChecks: [
                  {
                    externalId: "gitlab-job:2",
                    name: "phpunit",
                    outcome: "red",
                  },
                ],
              }),
              stderr: "",
            })
          },
        })
        const layer = keymaxxerGitLabLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const status = yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          return yield* gitlab.getPullRequestCheckStatus(
            repository,
            "rfa/project-oauth-client/42/wi-test",
          )
        }).pipe(Effect.provide(layer))

        expect(status).toEqual({
          _tag: "failed",
          mergeability: "mergeable",
          baseRefName: "1.0.x",
          headPushedAt: new Date("2026-07-20T10:04:00.000Z"),
          headSha: "deadbeef",
          createdAt: new Date("2026-07-20T10:00:00.000Z"),
          isDraft: true,
          terminalChecks: [
            {
              externalId: "gitlab-job:2",
              name: "phpunit",
              outcome: "red",
            },
          ],
        })
        expect(runs[0]?.command).toContain("get-pr-check-status")
        expect(runs[0]?.command).toContain('GITLAB_TOKEN="$')
        expect(runs[0]?.secrets).toEqual(["GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"])
      }),
  )

  it.effect("loads PR Status Check diagnostics through the vault secret", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(
            account === vaultAccount
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
                externalId: "gitlab-job:2",
                name: "phpunit",
                source: "gitlab-job",
                htmlUrl:
                  "https://git.drupalcode.org/project/oauth_client/-/jobs/2",
                logFetch: {
                  _tag: "ok",
                  excerpt: "FAIL: expected true\n",
                  localPath: null,
                },
              },
            ]),
            stderr: "",
          })
        },
      })
      const layer = keymaxxerGitLabLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
        Layer.provide(platformLayer),
      )

      const diagnostics = yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* gitlab.getPrStatusCheckDiagnostics(
          repository,
          [{ externalId: "gitlab-job:2", name: "phpunit" }],
          { logDirectory: "/tmp/worktree/.ready-for-agent/status-check-logs" },
        )
      }).pipe(Effect.provide(layer))

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
      expect(runs[0]?.command).toContain("get-pr-status-check-diagnostics")
      expect(runs[0]?.secrets).toEqual(["GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"])
    }),
  )

  it.effect(
    "marks a merge request ready for review through the vault secret",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: ({ account }) =>
            Effect.succeed(
              account === vaultAccount
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
              stdout: JSON.stringify({ _tag: "ready" }),
              stderr: "",
            })
          },
        })
        const layer = keymaxxerGitLabLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          yield* gitlab.markPullRequestReadyForReview(
            repository,
            "rfa/project-oauth-client/42/wi-test",
          )
        }).pipe(Effect.provide(layer))

        expect(runs[0]?.command).toContain("mark-pr-ready-for-review")
        expect(runs[0]?.command).toContain('GITLAB_TOKEN="$')
        expect(runs[0]?.secrets).toEqual(["GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"])
      }),
  )

  it.effect("merges a merge request through the vault secret", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: ({ account }) =>
          Effect.succeed(
            account === vaultAccount
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
            stdout: JSON.stringify({ _tag: "merged" }),
            stderr: "",
          })
        },
      })
      const layer = keymaxxerGitLabLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
        Layer.provide(platformLayer),
      )

      const result = yield* Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return yield* gitlab.mergePullRequest(
          repository,
          "rfa/project-oauth-client/42/wi-test",
        )
      }).pipe(Effect.provide(layer))

      expect(result).toEqual({ _tag: "merged" })
      expect(runs[0]?.command).toContain("merge-pull-request")
      expect(runs[0]?.command).toContain('GITLAB_TOKEN="$')
      expect(runs[0]?.secrets).toEqual(["GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"])
    }),
  )

  it.effect(
    "loads merge request lifecycle status through the vault secret",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: ({ account }) =>
            Effect.succeed(
              account === vaultAccount
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
              stdout: JSON.stringify({ _tag: "open" }),
              stderr: "",
            })
          },
        })
        const layer = keymaxxerGitLabLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer), Layer.provide(platformLayer))

        const status = yield* Effect.gen(function* () {
          const gitlab = yield* GitLabService
          return yield* gitlab.getPullRequestLifecycleStatus(
            repository,
            "rfa/project-oauth-client/42/wi-test",
          )
        }).pipe(Effect.provide(layer))

        expect(status).toEqual({ _tag: "open" })
        expect(runs[0]?.command).toContain("get-pr-lifecycle-status")
        expect(runs[0]?.secrets).toEqual(["GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"])
      }),
  )
})
