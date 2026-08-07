import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
} from "effect"
import { TestClock } from "effect/testing"
import {
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  GitHubThrottledError,
  githubHelperSuccess,
  githubHelperThrottled,
  serializeGitHubHelperControl,
} from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
import { ambientGitHubLayer } from "../src/server/ambient-github-layer.js"
import {
  GitHubOperationCoordinator,
  GitHubOperationCoordinatorLive,
  makeGitHubOperationCoordinator,
} from "../src/server/github-operation-coordinator.js"
import {
  OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS,
  keymaxxerGitHubLayer as makeKeymaxxerGitHubLayer,
} from "../src/server/keymaxxer-github-layer.js"

const keymaxxerGitHubLayer = (
  options: Parameters<typeof makeKeymaxxerGitHubLayer>[0],
) =>
  makeKeymaxxerGitHubLayer(options).pipe(
    Layer.provide(GitHubOperationCoordinatorLive),
  )

const processLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
)

const acmeWidgets = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
} as const

const acmeGadgets = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "acme/gadgets",
} as const

const successfulHelperControl = serializeGitHubHelperControl(
  githubHelperSuccess(),
)

describe("Keymaxxer-backed GitHub layer", () => {
  it.effect(
    "does not prompt Keymaxxer when a repository token is missing",
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
            return Effect.succeed({
              exitCode: 0,
              stdout: "[]",
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const exit = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* Effect.exit(
            github.listReadyIssues({
              forge: "github",
              forgeHost: "github.com",
              projectPath: "foo-bar/baz",
            }),
          )
        }).pipe(Effect.provide(layer))

        expect(exit._tag).toBe("Failure")
        expect(addCalled).toBe(false)
        expect(runs).toHaveLength(0)
      }),
  )

  it.effect("selects colliding token names by Repository account", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const tokens = new Map([
        ["foo-bar/baz", "TOKEN_FOR_FIRST_REPOSITORY"],
        ["foo/bar-baz", "TOKEN_FOR_SECOND_REPOSITORY"],
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
          return Effect.succeed({
            exitCode: 0,
            stdout: "[]",
            stderr: successfulHelperControl,
          })
        },
      })
      const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
      )

      yield* Effect.gen(function* () {
        const github = yield* GitHubService
        yield* github.listReadyIssues({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "foo-bar/baz",
        })
        yield* github.listReadyIssues({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "foo/bar-baz",
        })
      }).pipe(Effect.provide(layer))

      expect(runs.map(({ secrets }) => secrets)).toEqual([
        ["TOKEN_FOR_FIRST_REPOSITORY"],
        ["TOKEN_FOR_SECOND_REPOSITORY"],
      ])
    }),
  )

  it.effect(
    "obtains the configured repository GitHub token through Keymaxxer",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: ({ account }) =>
            Effect.succeed(
              account === "acme/widgets" ? "GITHUB_TOKEN_ACME_WIDGETS" : null,
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
                  url: "https://github.com/acme/widgets/issues/7",
                  createdAt: "2026-07-07T12:00:00.000Z",
                  state: "OPEN",
                  author: "octocat",
                  hierarchySupported: true,
                  closingPullRequests: [],
                  hasChildren: false,
                  parentPosition: 0,
                  parent: {
                    number: 1,
                    url: "https://github.com/acme/widgets/issues/1",
                    state: "OPEN",
                    isReadyLabeled: true,
                  },
                  blockedBy: [
                    {
                      number: 3,
                      url: "https://github.com/acme/widgets/issues/3",
                    },
                  ],
                },
              ]),
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const results = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* Effect.all(
            [
              github.listReadyIssues({
                forge: "github",
                forgeHost: "github.com",
                projectPath: "acme/widgets",
              }),
              github.listReadyIssues({
                forge: "github",
                forgeHost: "github.com",
                projectPath: "acme/widgets",
              }),
            ],
            { concurrency: "unbounded" },
          )
        }).pipe(Effect.provide(layer))

        expect(results[0]?.[0]?.createdAt).toEqual(
          new Date("2026-07-07T12:00:00.000Z"),
        )
        expect(results[0]?.[0]?.blockedBy).toEqual([
          {
            number: 3,
            url: "https://github.com/acme/widgets/issues/3",
          },
        ])
        expect(results[0]?.[0]?.parent).toEqual({
          number: 1,
          url: "https://github.com/acme/widgets/issues/1",
          state: "OPEN",
          isReadyLabeled: true,
        })
        expect(runs).toHaveLength(2)
        expect(runs.map(({ secrets }) => secrets)).toEqual([
          ["GITHUB_TOKEN_ACME_WIDGETS"],
          ["GITHUB_TOKEN_ACME_WIDGETS"],
        ])
        expect(
          runs[0]?.command.startsWith(
            'GITHUB_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS" ',
          ),
        ).toBe(true)
        expect(runs[0]?.command).toContain("list-ready-issues.ts")
        expect(runs[0]?.command).toMatch(
          /"--conditions" "@ready-for-agent\/source" "\/.*list-ready-issues\.ts"/,
        )
        expect(runs[0]?.command).not.toContain(
          "--ready-for-agent-internal-github-helper",
        )
        expect(runs[0]?.cwd).toBe("/workspace")
        expect(runs[0]?.command).not.toContain("Ready issue")
      }),
  )

  it.effect("checks a PR branch through the configured repository token", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: (input) => {
          runs.push(input)
          return Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify({
              _tag: "failed",
              mergeability: "conflicting",
              baseRefName: "develop",
              headPushedAt: null,
              headSha: null,
              createdAt: null,
              isDraft: null,
              terminalChecks: [
                {
                  externalId: "checkrun:1",
                  name: "lint",
                  outcome: "red",
                },
              ],
            }),
            stderr: successfulHelperControl,
          })
        },
      })
      const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
      )

      const status = yield* Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getPullRequestCheckStatus(
          {
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
          },
          "rfa/acme-widgets/42/wi-test",
        )
      }).pipe(Effect.provide(layer))

      expect(status).toEqual({
        _tag: "failed",
        mergeability: "conflicting",
        baseRefName: "develop",
        headPushedAt: null,
        headSha: null,
        createdAt: null,
        isDraft: null,
        terminalChecks: [
          {
            externalId: "checkrun:1",
            name: "lint",
            outcome: "red",
          },
        ],
      })
      expect(runs[0]?.command).toContain("get-pr-check-status.ts")
      expect(runs[0]?.command).toContain('"--conditions"')
      expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
    }),
  )

  it.effect("maps unparseable PR check-status instants to null", () =>
    Effect.gen(function* () {
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: () =>
          Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify({
              _tag: "succeeded",
              mergeability: "mergeable",
              baseRefName: "main",
              headPushedAt: "not-a-date",
              headSha: "abc123",
              createdAt: "garbage",
              isDraft: false,
              terminalChecks: [
                {
                  externalId: "checkrun:1",
                  name: "lint",
                  outcome: "green",
                },
              ],
            }),
            stderr: successfulHelperControl,
          }),
      })
      const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
      )

      const status = yield* Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getPullRequestCheckStatus(
          {
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
          },
          "rfa/acme-widgets/42/wi-test",
        )
      }).pipe(Effect.provide(layer))

      expect(status).toEqual({
        _tag: "succeeded",
        mergeability: "mergeable",
        baseRefName: "main",
        headPushedAt: null,
        headSha: "abc123",
        createdAt: null,
        isDraft: false,
        terminalChecks: [
          {
            externalId: "checkrun:1",
            name: "lint",
            outcome: "green",
          },
        ],
      })
    }),
  )

  it.effect(
    "resolves an open PR number through the configured repository token",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            return Effect.succeed({
              exitCode: 0,
              stdout: "321",
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const number = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* github.getOpenPullRequestNumber(
            {
              forge: "github",
              forgeHost: "github.com",
              projectPath: "acme/widgets",
            },
            "rfa/acme-widgets/42/wi-test",
          )
        }).pipe(Effect.provide(layer))

        expect(number).toBe(321)
        expect(runs[0]?.command).toContain("get-open-pr-number.ts")
        expect(runs[0]?.command).toContain('"--conditions"')
      }),
  )

  it.effect(
    "counts open non-draft pull requests through the configured repository token",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            return Effect.succeed({
              exitCode: 0,
              stdout: "4",
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const count = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* github.countOpenNonDraftPullRequests({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
          })
        }).pipe(Effect.provide(layer))

        expect(count).toBe(4)
        expect(runs[0]?.command).toContain(
          "count-open-non-draft-pull-requests.ts",
        )
        expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
      }),
  )

  it.effect(
    "empty stdout on exit 0 is a decode error and is not success-cached as zero",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            if (runs.length === 1) {
              return Effect.succeed({
                exitCode: 0,
                stdout: "   ",
                stderr: successfulHelperControl,
              })
            }
            return Effect.succeed({
              exitCode: 0,
              stdout: "3",
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 60_000,
        }).pipe(
          Layer.provide(keymaxxerLayer),
          Layer.provideMerge(TestClock.layer()),
        )

        yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* Effect.exit(
            github.countOpenNonDraftPullRequests(acmeWidgets),
          )
          expect(Exit.isFailure(first)).toBe(true)

          // Failure TTL is zero; no clock advance needed for a retry.
          const second =
            yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          expect(second).toBe(3)
        }).pipe(Effect.provide(layer))

        expect(runs).toHaveLength(2)
      }),
  )

  it.effect("decodes no_checks and pending terminalChecks from the bin", () =>
    Effect.gen(function* () {
      const responses = [
        JSON.stringify({
          _tag: "no_checks",
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
        }),
        JSON.stringify({
          _tag: "pending",
          mergeability: "unknown",
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
          terminalChecks: [
            {
              externalId: "status:SC_ci",
              name: "ci",
              outcome: "green",
            },
          ],
        }),
      ]
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: () =>
          Effect.succeed({
            exitCode: 0,
            stdout: responses.shift()!,
            stderr: successfulHelperControl,
          }),
      })
      const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
      )

      const noChecks = yield* Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getPullRequestCheckStatus(
          {
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
          },
          "branch",
        )
      }).pipe(Effect.provide(layer))
      expect(noChecks).toEqual({
        _tag: "no_checks",
        mergeability: "mergeable",
        baseRefName: "main",
        headPushedAt: null,
        headSha: null,
        createdAt: null,
        isDraft: null,
      })

      const pending = yield* Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getPullRequestCheckStatus(
          {
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
          },
          "branch",
        )
      }).pipe(Effect.provide(layer))
      expect(pending).toEqual({
        _tag: "pending",
        mergeability: "unknown",
        baseRefName: "main",
        headPushedAt: null,
        headSha: null,
        createdAt: null,
        isDraft: null,
        terminalChecks: [
          {
            externalId: "status:SC_ci",
            name: "ci",
            outcome: "green",
          },
        ],
      })
    }),
  )

  it.effect(
    "marks a PR ready for review through the configured repository token",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            return Effect.succeed({
              exitCode: 0,
              stdout: JSON.stringify({ _tag: "ready" }),
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        yield* Effect.gen(function* () {
          const github = yield* GitHubService
          yield* github.markPullRequestReadyForReview(
            {
              forge: "github",
              forgeHost: "github.com",
              projectPath: "acme/widgets",
            },
            "rfa/acme-widgets/42/wi-test",
          )
        }).pipe(Effect.provide(layer))

        expect(runs[0]?.command).toContain("mark-pr-ready-for-review.ts")
        expect(runs[0]?.command).toContain('"--conditions"')
        expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
      }),
  )

  it.effect(
    "does not surface raw helper stderr in GitHubRequestError messages",
    () =>
      Effect.gen(function* () {
        const esc = String.fromCharCode(0x1b)
        const secret = "ghp_helper_stderr_must_not_escape"
        const ansiDump = `{\n  ${esc}[0m_tag${esc}[2m:${esc}[0m ${esc}[32m"GitHubRequestError"${esc}[0m,\n  ${esc}[0mmessage${esc}[2m:${esc}[0m ${esc}[32m"HTTP 401: Bad credentials ${secret}"${esc}[0m,\n}`
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.succeed({
              exitCode: 1,
              stdout: "",
              stderr: ansiDump,
            }),
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const error = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* github
            .getPullRequestCheckStatus(
              {
                forge: "github",
                forgeHost: "github.com",
                projectPath: "processfocus/monorepo",
              },
              "branch",
            )
            .pipe(Effect.flip)
        }).pipe(Effect.provide(layer))

        expect(error).toBeInstanceOf(GitHubRequestError)
        expect(error.message).toBe(
          "Failed to get pull request check status for processfocus/monorepo",
        )
        expect(error.message.includes(`${esc}[`)).toBe(false)
        expect(error.message).not.toContain("_tag")
        expect(error.message).not.toContain("Bad credentials")
        expect(error.message).not.toContain(secret)
      }),
  )

  it.effect(
    "does not surface raw successful-helper stdout in decode errors",
    () =>
      Effect.gen(function* () {
        const secret = "ghp_helper_stdout_must_not_escape"
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.succeed({
              exitCode: 0,
              stdout: secret,
              stderr: successfulHelperControl,
            }),
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const error = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* github
            .countOpenNonDraftPullRequests(acmeWidgets)
            .pipe(Effect.flip)
        }).pipe(Effect.provide(layer))

        expect(error).toBeInstanceOf(GitHubRequestError)
        expect(error.message).not.toContain(secret)
      }),
  )

  it.effect("merges a PR through the configured repository token", () =>
    Effect.gen(function* () {
      const runs: RunWithSecretsInput[] = []
      const serializedOutcomes = [
        { _tag: "merged" },
        {
          _tag: "revalidation",
          reason: "head_changed",
          message: "Head changed",
        },
        {
          _tag: "needs_human",
          reason: "merge_rejected",
          message: "Merge rejected",
        },
      ] as const
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: (input) => {
          runs.push(input)
          return Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify(serializedOutcomes[runs.length - 1]),
            stderr: successfulHelperControl,
          })
        },
      })
      const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
      )

      const outcomes = yield* Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* Effect.forEach(serializedOutcomes, () =>
          github.mergePullRequest(
            {
              forge: "github",
              forgeHost: "github.com",
              projectPath: "acme/widgets",
            },
            "rfa/acme-widgets/42/wi-test",
          ),
        )
      }).pipe(Effect.provide(layer))

      expect(runs[0]?.command).toContain("merge-pull-request.ts")
      expect(runs[0]?.command).toContain('"--conditions"')
      expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
      expect(outcomes).toEqual([...serializedOutcomes])
    }),
  )

  it.effect("rejects malformed Ready Issue fields through Schema", () =>
    Effect.gen(function* () {
      const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
        findSecrets: () => Effect.die("not used"),
        hasSecret: () => Effect.die("not used"),
        addSecret: () => Effect.die("not used"),
        runWithSecrets: () =>
          Effect.succeed({
            exitCode: 0,
            stdout: JSON.stringify([
              {
                number: 0,
                title: " ",
                body: "Issue body",
                url: "not-a-url",
                createdAt: "not-a-date",
                state: "OPEN",
                hierarchySupported: true,
                hasChildren: false,
                parentPosition: -1,
                parent: null,
                blockedBy: [],
                closingPullRequests: [],
              },
            ]),
            stderr: successfulHelperControl,
          }),
      })
      const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
      )

      const error = yield* Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github
          .listReadyIssues({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
          })
          .pipe(Effect.flip)
      }).pipe(Effect.provide(layer))

      expect(error).toBeInstanceOf(GitHubRequestError)
      expect(error.message).toBe(
        "Failed to list Ready-labeled Issues for acme/widgets",
      )
    }),
  )

  it("freshness window is shorter than the UI open-PR count poll interval", () => {
    // UI poll is 30_000ms; reuse must expire so automatic refresh can observe changes.
    expect(OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS).toBeGreaterThan(0)
    expect(OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS).toBeLessThan(30_000)
  })

  // Real wall-clock coordination: hold the helper open so concurrent callers
  // join one in-flight Cache lookup rather than racing TestClock.
  it.live(
    "concurrent count requests for one Repository share one Keymaxxer helper",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const helperStarted = yield* Deferred.make<void>()
        const releaseHelper = yield* Deferred.make<void>()
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) =>
            Effect.gen(function* () {
              runs.push(input)
              yield* Deferred.succeed(helperStarted, undefined)
              yield* Deferred.await(releaseHelper)
              return {
                exitCode: 0,
                stdout: "7",
                stderr: successfulHelperControl,
              }
            }),
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const fiber = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* Effect.all(
            [
              github.countOpenNonDraftPullRequests(acmeWidgets),
              github.countOpenNonDraftPullRequests(acmeWidgets),
            ],
            { concurrency: 2 },
          )
        }).pipe(Effect.provide(layer), Effect.forkChild)

        yield* Deferred.await(helperStarted)
        expect(runs).toHaveLength(1)
        yield* Deferred.succeed(releaseHelper, undefined)
        const counts = yield* Fiber.join(fiber)

        expect(counts).toEqual([7, 7])
        expect(runs).toHaveLength(1)
        expect(runs[0]?.command).toContain(
          "count-open-non-draft-pull-requests.ts",
        )
        expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
      }),
  )

  it("concurrent count joiners survive cancel of the cache owner fiber", async () => {
    // A concurrent waiter keeps the shared lookup alive when its owner aborts.
    const runs: RunWithSecretsInput[] = []
    let releaseHelper: (() => void) | undefined
    const helperHeld = new Promise<void>((resolve) => {
      releaseHelper = resolve
    })
    let helperStarts = 0
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: (input) =>
        Effect.gen(function* () {
          runs.push(input)
          helperStarts += 1
          yield* Effect.promise(() => helperHeld)
          return { exitCode: 0, stdout: "7", stderr: successfulHelperControl }
        }),
    })
    const runtime = ManagedRuntime.make(
      keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
      ),
    )
    await runtime.context()

    const countOnce = Effect.gen(function* () {
      const github = yield* GitHubService
      return yield* github.countOpenNonDraftPullRequests(acmeWidgets)
    })

    const ownerController = new AbortController()
    const owner = runtime
      .runPromise(countOnce, { signal: ownerController.signal })
      .catch(() => undefined)
    const joiner = runtime.runPromise(countOnce)

    for (let i = 0; i < 100 && helperStarts < 1; i += 1) {
      await Bun.sleep(5)
    }
    expect(helperStarts).toBe(1)
    ownerController.abort()
    await owner
    releaseHelper?.()

    try {
      expect(await joiner).toBe(7)
      expect(runs).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it("cancels a queued count cache miss before it starts the helper", async () => {
    let releaseActiveHelper: () => void = () => {}
    const activeHelperHeld = new Promise<void>((resolve) => {
      releaseActiveHelper = resolve
    })
    let signalActiveHelperStart: () => void = () => {}
    const activeHelperStarted = new Promise<void>((resolve) => {
      signalActiveHelperStart = resolve
    })
    let signalCountCoordinatorEntry: () => void = () => {}
    const countCoordinatorEntered = new Promise<void>((resolve) => {
      signalCountCoordinatorEntry = resolve
    })
    let countHelperStarts = 0
    const coordinator = makeGitHubOperationCoordinator()
    const coordinatorLayer = Layer.succeed(GitHubOperationCoordinator, {
      execute: (input) => {
        if (input.origin === "background") {
          signalCountCoordinatorEntry()
        }
        return coordinator.execute(input)
      },
      reportThrottle: (throttle) => coordinator.reportThrottle(throttle),
      throttleStatus: () => coordinator.throttleStatus(),
    })
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      runWithSecrets: (input) =>
        Effect.gen(function* () {
          if (input.command.includes("count-open-non-draft-pull-requests.ts")) {
            countHelperStarts += 1
            return { exitCode: 0, stdout: "7", stderr: successfulHelperControl }
          }
          signalActiveHelperStart()
          yield* Effect.promise(() => activeHelperHeld)
          return {
            exitCode: 0,
            stdout: JSON.stringify({ _tag: "open" }),
            stderr: successfulHelperControl,
          }
        }),
    })
    const runtime = ManagedRuntime.make(
      makeKeymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
        Layer.provide(keymaxxerLayer),
        Layer.provide(coordinatorLayer),
      ),
    )
    await runtime.context()

    const countOnce = Effect.gen(function* () {
      const github = yield* GitHubService
      return yield* github.countOpenNonDraftPullRequests(acmeWidgets)
    })
    const holdPermit = Effect.gen(function* () {
      const github = yield* GitHubService
      return yield* github.getPullRequestLifecycleStatus(acmeWidgets, "branch")
    })

    const active = runtime.runPromise(holdPermit)
    await activeHelperStarted
    const controller = new AbortController()
    const cancelledCount = runtime
      .runPromise(countOnce, { signal: controller.signal })
      .catch(() => undefined)

    try {
      // The count miss has submitted its background operation behind the held
      // lifecycle operation, so cancellation exercises its queued path.
      await countCoordinatorEntered
      controller.abort()
      await cancelledCount
      releaseActiveHelper()
      await active

      expect(countHelperStarts).toBe(0)
    } finally {
      releaseActiveHelper()
      await runtime.dispose()
    }
  })

  it.effect(
    "count requests for different Repositories never share credentials or results",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const tokens = new Map([
          ["acme/widgets", "TOKEN_WIDGETS"],
          ["acme/gadgets", "TOKEN_GADGETS"],
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
            const stdout = input.secrets[0] === "TOKEN_WIDGETS" ? "2" : "9"
            return Effect.succeed({
              exitCode: 0,
              stdout,
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const counts = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* Effect.all(
            [
              github.countOpenNonDraftPullRequests(acmeWidgets),
              github.countOpenNonDraftPullRequests(acmeGadgets),
            ],
            { concurrency: 2 },
          )
        }).pipe(Effect.provide(layer))

        expect(counts).toEqual([2, 9])
        expect(runs).toHaveLength(2)
        expect(runs.map(({ secrets }) => secrets).sort()).toEqual([
          ["TOKEN_GADGETS"],
          ["TOKEN_WIDGETS"],
        ])
      }),
  )

  it.effect(
    "closely spaced successful counts reuse the freshness window without a second helper",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            return Effect.succeed({
              exitCode: 0,
              stdout: String(runs.length),
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 5_000,
        }).pipe(
          Layer.provide(keymaxxerLayer),
          Layer.provideMerge(TestClock.layer()),
        )

        const counts = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          yield* TestClock.adjust(1_000)
          const second =
            yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          return [first, second] as const
        }).pipe(Effect.provide(layer))

        expect(counts).toEqual([1, 1])
        expect(runs).toHaveLength(1)
      }),
  )

  it.effect(
    "expiry permits a later request to observe a changed GitHub count",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            return Effect.succeed({
              exitCode: 0,
              stdout: String(runs.length * 3),
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 5_000,
        }).pipe(
          Layer.provide(keymaxxerLayer),
          Layer.provideMerge(TestClock.layer()),
        )

        const counts = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          yield* TestClock.adjust(5_000)
          const second =
            yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          return [first, second] as const
        }).pipe(Effect.provide(layer))

        expect(counts).toEqual([3, 6])
        expect(runs).toHaveLength(2)
      }),
  )

  it.effect(
    "GitHub and Keymaxxer failures are not stored as successful zero counts",
    () =>
      Effect.gen(function* () {
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            if (runs.length === 1) {
              return Effect.succeed({
                exitCode: 1,
                stdout: "",
                stderr: "upstream boom",
              })
            }
            if (runs.length === 2) {
              return Effect.succeed({
                exitCode: 2,
                stdout: "",
                stderr: "",
              })
            }
            return Effect.succeed({
              exitCode: 0,
              stdout: "0",
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 60_000,
        }).pipe(
          Layer.provide(keymaxxerLayer),
          Layer.provideMerge(TestClock.layer()),
        )

        yield* Effect.gen(function* () {
          const github = yield* GitHubService

          const requestFailure = yield* Effect.exit(
            github.countOpenNonDraftPullRequests(acmeWidgets),
          )
          expect(Exit.isFailure(requestFailure)).toBe(true)

          // Failure TTL is zero — retries must not see a cached zero.
          const unavailable = yield* Effect.exit(
            github.countOpenNonDraftPullRequests(acmeWidgets),
          )
          expect(Exit.isFailure(unavailable)).toBe(true)
          if (Exit.isFailure(unavailable)) {
            const error = unavailable.cause
            // Ensure we did not swallow unavailable into a cached zero.
            expect(String(error)).toContain("GitHubRepositoryUnavailableError")
          }

          const zero = yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          expect(zero).toBe(0)

          // Genuine zero is success-cached; failures above must not have been.
          const cachedZero =
            yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          expect(cachedZero).toBe(0)
        }).pipe(Effect.provide(layer))

        expect(runs).toHaveLength(3)
      }),
  )

  it.effect(
    "a successful count cache hit bypasses a held coordinator permit",
    () =>
      Effect.gen(function* () {
        const lifecycleHelperStarted = yield* Deferred.make<void>()
        const releaseLifecycleHelper = yield* Deferred.make<void>()
        let helperCalls = 0
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) =>
            Effect.gen(function* () {
              helperCalls += 1
              if (
                input.command.includes("count-open-non-draft-pull-requests.ts")
              ) {
                return {
                  exitCode: 0,
                  stdout: "8",
                  stderr: successfulHelperControl,
                }
              }
              yield* Deferred.succeed(lifecycleHelperStarted, undefined)
              yield* Deferred.await(releaseLifecycleHelper)
              return {
                exitCode: 0,
                stdout: JSON.stringify({ _tag: "open" }),
                stderr: successfulHelperControl,
              }
            }),
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 60_000,
        }).pipe(Layer.provide(keymaxxerLayer))
        const context = yield* Layer.buildWithScope(layer, yield* Effect.scope)
        const github = Context.get(context, GitHubService)
        expect(yield* github.countOpenNonDraftPullRequests(acmeWidgets)).toBe(8)

        const lifecycle = yield* github
          .getPullRequestLifecycleStatus(acmeWidgets, "branch")
          .pipe(Effect.forkChild)
        yield* Deferred.await(lifecycleHelperStarted)

        expect(yield* github.countOpenNonDraftPullRequests(acmeWidgets)).toBe(8)
        expect(helperCalls).toBe(2)

        yield* Deferred.succeed(releaseLifecycleHelper, undefined)
        expect((yield* Fiber.join(lifecycle))._tag).toBe("open")
      }),
  )

  it.effect(
    "Keymaxxer and ambient GitHub operations share one runtime coordinator",
    () =>
      Effect.gen(function* () {
        const helperStarted = yield* Deferred.make<void>()
        const releaseHelper = yield* Deferred.make<void>()
        let ambientTokenResolutions = 0
        let ambientOperations = 0
        const coordinator = makeGitHubOperationCoordinator()
        const coordinatorLayer = Layer.succeed(
          GitHubOperationCoordinator,
          coordinator,
        )
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(helperStarted, undefined)
              yield* Deferred.await(releaseHelper)
              return {
                exitCode: 0,
                stdout: JSON.stringify({ _tag: "open" }),
                stderr: successfulHelperControl,
              }
            }),
        })
        const ambientService = {
          listReadyIssues: () =>
            Effect.sync(() => {
              ambientOperations += 1
              return []
            }),
          getAuthenticatedUserLogin: () => Effect.die("not used"),
          getOpenPullRequestNumber: () => Effect.die("not used"),
          findOpenPullRequestNumber: () => Effect.die("not used"),
          createDraftPullRequest: () => Effect.die("not used"),
          updateOpenDraftPullRequestCopy: () => Effect.die("not used"),
          countOpenNonDraftPullRequests: () => Effect.die("not used"),
          getPullRequestCheckStatus: () => Effect.die("not used"),
          getPrStatusCheckDiagnostics: () => Effect.die("not used"),
          observeAutomatedReviewEvidence: () => Effect.die("not used"),
          getPullRequestLifecycleStatus: () => Effect.die("not used"),
          markPullRequestReadyForReview: () => Effect.die("not used"),
          mergePullRequest: () => Effect.die("not used"),
          rerunWorkflowRun: () => Effect.die("not used"),
          ensureIssueCompletedWithSummary: () => Effect.die("not used"),
        } satisfies GitHubServiceShape
        const scope = yield* Effect.scope
        const keymaxxerContext = yield* Layer.buildWithScope(
          makeKeymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
            Layer.provide(keymaxxerLayer),
            Layer.provide(coordinatorLayer),
          ),
          scope,
        )
        const ambientContext = yield* Layer.buildWithScope(
          ambientGitHubLayer({
            workspaceRoot: "/workspace",
            resolveToken: async () => {
              ambientTokenResolutions += 1
              return "ambient-token"
            },
            makeService: () => ambientService,
          }).pipe(Layer.provide(coordinatorLayer), Layer.provide(processLayer)),
          scope,
        )
        const keymaxxer = Context.get(keymaxxerContext, GitHubService)
        const ambient = Context.get(ambientContext, GitHubService)

        const keymaxxerOperation = yield* keymaxxer
          .getPullRequestLifecycleStatus(acmeWidgets, "branch")
          .pipe(Effect.forkChild)
        yield* Deferred.await(helperStarted)

        const ambientOperation = yield* ambient
          .listReadyIssues(acmeWidgets)
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(ambientTokenResolutions).toBe(0)
        expect(ambientOperations).toBe(0)

        yield* Deferred.succeed(releaseHelper, undefined)
        expect((yield* Fiber.join(keymaxxerOperation))._tag).toBe("open")
        expect(yield* Fiber.join(ambientOperation)).toEqual([])
        expect(ambientTokenResolutions).toBe(1)
        expect(ambientOperations).toBe(1)
      }),
  )

  it.effect(
    "a throttled count cache miss reaches neither GitHub adapter before its retry deadline",
    () =>
      Effect.gen(function* () {
        let keymaxxerSecretLookups = 0
        let keymaxxerHelperRuns = 0
        let ambientTokenResolutions = 0
        let ambientCountOperations = 0
        const coordinator = makeGitHubOperationCoordinator()
        coordinator.reportThrottle(
          new GitHubThrottledError({
            retryAt: Date.now() + 60_000,
            usedFallback: false,
          }),
        )
        const coordinatorLayer = Layer.succeed(
          GitHubOperationCoordinator,
          coordinator,
        )
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () =>
            Effect.sync(() => {
              keymaxxerSecretLookups += 1
              return "GITHUB_TOKEN_ACME_WIDGETS"
            }),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.sync(() => {
              keymaxxerHelperRuns += 1
              return {
                exitCode: 0,
                stdout: "7",
                stderr: successfulHelperControl,
              }
            }),
        })
        const ambientService = {
          listReadyIssues: () => Effect.die("not used"),
          getAuthenticatedUserLogin: () => Effect.die("not used"),
          getOpenPullRequestNumber: () => Effect.die("not used"),
          findOpenPullRequestNumber: () => Effect.die("not used"),
          createDraftPullRequest: () => Effect.die("not used"),
          updateOpenDraftPullRequestCopy: () => Effect.die("not used"),
          countOpenNonDraftPullRequests: () =>
            Effect.sync(() => {
              ambientCountOperations += 1
              return 7
            }),
          getPullRequestCheckStatus: () => Effect.die("not used"),
          getPrStatusCheckDiagnostics: () => Effect.die("not used"),
          observeAutomatedReviewEvidence: () => Effect.die("not used"),
          getPullRequestLifecycleStatus: () => Effect.die("not used"),
          markPullRequestReadyForReview: () => Effect.die("not used"),
          mergePullRequest: () => Effect.die("not used"),
          rerunWorkflowRun: () => Effect.die("not used"),
          ensureIssueCompletedWithSummary: () => Effect.die("not used"),
        } satisfies GitHubServiceShape
        const scope = yield* Effect.scope
        const keymaxxerContext = yield* Layer.buildWithScope(
          makeKeymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
            Layer.provide(keymaxxerLayer),
            Layer.provide(coordinatorLayer),
          ),
          scope,
        )
        const ambientContext = yield* Layer.buildWithScope(
          ambientGitHubLayer({
            workspaceRoot: "/workspace",
            resolveToken: async () => {
              ambientTokenResolutions += 1
              return "ambient-token"
            },
            makeService: () => ambientService,
          }).pipe(Layer.provide(coordinatorLayer), Layer.provide(processLayer)),
          scope,
        )
        const keymaxxer = Context.get(keymaxxerContext, GitHubService)
        const ambient = Context.get(ambientContext, GitHubService)

        const [keymaxxerFailure, ambientFailure] = yield* Effect.all([
          keymaxxer
            .countOpenNonDraftPullRequests(acmeWidgets)
            .pipe(Effect.flip),
          ambient.countOpenNonDraftPullRequests(acmeWidgets).pipe(Effect.flip),
        ])

        expect(keymaxxerFailure).toBeInstanceOf(GitHubThrottledError)
        expect(ambientFailure).toBeInstanceOf(GitHubThrottledError)
        expect(keymaxxerSecretLookups).toBe(0)
        expect(keymaxxerHelperRuns).toBe(0)
        expect(ambientTokenResolutions).toBe(0)
        expect(ambientCountOperations).toBe(0)
      }),
  )

  it.effect(
    "raw Forge credentials stay in the Keymaxxer child and never enter the count result path",
    () =>
      Effect.gen(function* () {
        const secretName = "GITHUB_TOKEN_ACME_WIDGETS"
        const rawToken = "ghp_this_must_never_appear_in_harness_memory_path"
        const runs: RunWithSecretsInput[] = []
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed(secretName),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            // Keymaxxer injects the secret by name into the child env; the Harness
            // only sees the secret name and the child's decoded stdout count.
            expect(input.secrets).toEqual([secretName])
            expect(input.command).toContain(`GITHUB_TOKEN="$${secretName}"`)
            expect(JSON.stringify(input)).not.toContain(rawToken)
            return Effect.succeed({
              exitCode: 0,
              stdout: "5",
              stderr: successfulHelperControl,
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const count = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* github.countOpenNonDraftPullRequests(acmeWidgets)
        }).pipe(Effect.provide(layer))

        expect(count).toBe(5)
        expect(runs).toHaveLength(1)
        expect(JSON.stringify(runs)).not.toContain(rawToken)
      }),
  )

  it.effect(
    "reconstructs a typed GitHub throttle from a full helper control result",
    () =>
      Effect.gen(function* () {
        const retryAt = Date.now() + 60_000
        let helperRuns = 0
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () => {
            helperRuns += 1
            return Effect.succeed({
              exitCode: 3,
              stdout: "",
              stderr: serializeGitHubHelperControl(
                githubHelperThrottled({ retryAt, usedFallback: false }),
              ),
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const [first, second] = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* github
            .getOpenPullRequestNumber(acmeWidgets, "first")
            .pipe(Effect.flip)
          const second = yield* github
            .getOpenPullRequestNumber(acmeWidgets, "second")
            .pipe(Effect.flip)
          return [first, second] as const
        }).pipe(Effect.provide(layer))
        expect(first).toBeInstanceOf(GitHubThrottledError)
        if (first instanceof GitHubThrottledError) {
          expect(first.retryAt).toBe(retryAt)
        }
        expect(second).toBeInstanceOf(GitHubThrottledError)
        expect(helperRuns).toBe(1)
      }),
  )

  it.effect(
    "fails malformed helper throttle results without guessing or exposing their payload",
    () =>
      Effect.gen(function* () {
        const secret = "ghp_helper_protocol_secret"
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.succeed({
              exitCode: 3,
              stdout: "",
              stderr: JSON.stringify({
                version: 99,
                kind: "github-throttled",
                retryAt: Date.now() + 60_000,
                usedFallback: false,
                secret,
              }),
            }),
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))
        const error = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* github
            .getOpenPullRequestNumber(acmeWidgets, "branch")
            .pipe(Effect.flip)
        }).pipe(Effect.provide(layer))

        expect(error).toBeInstanceOf(GitHubRequestError)
        expect(error.message).not.toContain(secret)
      }),
  )

  it.effect(
    "rejects successful helper results without the required control record",
    () =>
      Effect.gen(function* () {
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "7", stderr: "" }),
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))
        const error = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          return yield* github
            .getOpenPullRequestNumber(acmeWidgets, "branch")
            .pipe(Effect.flip)
        }).pipe(Effect.provide(layer))

        expect(error).toBeInstanceOf(GitHubRequestError)
      }),
  )

  it.effect(
    "closes future Keymaxxer admission after a successful final-quota helper result",
    () =>
      Effect.gen(function* () {
        const retryAt = Date.now() + 60_000
        let helperRuns = 0
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: () => {
            helperRuns += 1
            return Effect.succeed({
              exitCode: 0,
              stdout: "7",
              stderr: serializeGitHubHelperControl(
                githubHelperSuccess({
                  throttle: { retryAt, usedFallback: false },
                }),
              ),
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
        }).pipe(Layer.provide(keymaxxerLayer))

        const [first, second] = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* github.getOpenPullRequestNumber(
            acmeWidgets,
            "first",
          )
          const second = yield* github
            .getOpenPullRequestNumber(acmeWidgets, "second")
            .pipe(Effect.flip)
          return [first, second] as const
        }).pipe(Effect.provide(layer))
        expect(first).toBe(7)
        expect(second).toBeInstanceOf(GitHubThrottledError)
        if (second instanceof GitHubThrottledError) {
          expect(second.retryAt).toBe(retryAt)
        }
        expect(helperRuns).toBe(1)
      }),
  )
})
