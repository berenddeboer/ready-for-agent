import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  GitHubRequestError,
  GitHubService,
} from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
import {
  OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS,
  keymaxxerGitHubLayer,
} from "../src/server/keymaxxer-github-layer.js"

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
            return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
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
          return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
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
              stderr: "",
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
            stderr: "",
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
            stderr: "",
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
            return Effect.succeed({ exitCode: 0, stdout: "321", stderr: "" })
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
            return Effect.succeed({ exitCode: 0, stdout: "4", stderr: "" })
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
        let clock = 50_000
        const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          findSecrets: () => Effect.die("not used"),
          hasSecret: () => Effect.die("not used"),
          addSecret: () => Effect.die("not used"),
          runWithSecrets: (input) => {
            runs.push(input)
            if (runs.length === 1) {
              return Effect.succeed({ exitCode: 0, stdout: "   ", stderr: "" })
            }
            return Effect.succeed({ exitCode: 0, stdout: "3", stderr: "" })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 60_000,
          nowMs: () => clock,
        }).pipe(Layer.provide(keymaxxerLayer))

        yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* Effect.exit(
            github.countOpenNonDraftPullRequests(acmeWidgets),
          )
          expect(Exit.isFailure(first)).toBe(true)

          clock += 10
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
            stderr: "",
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
              stderr: "",
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
    "sanitizes ANSI Effect dumps from CLI stderr into plain GitHubRequestError messages",
    () =>
      Effect.gen(function* () {
        const esc = String.fromCharCode(0x1b)
        const ansiDump = `{\n  ${esc}[0m_tag${esc}[2m:${esc}[0m ${esc}[32m"GitHubRequestError"${esc}[0m,\n  ${esc}[0mmessage${esc}[2m:${esc}[0m ${esc}[32m"HTTP 401: Bad credentials"${esc}[0m,\n}`
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
          "Failed to get pull request check status for processfocus/monorepo: HTTP 401: Bad credentials",
        )
        expect(error.message.includes(`${esc}[`)).toBe(false)
        expect(error.message).not.toContain("_tag")
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
            stderr: "",
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
            stderr: "",
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
  // join one in-flight Deferred rather than racing TestClock.
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
              return { exitCode: 0, stdout: "7", stderr: "" }
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
            return Effect.succeed({ exitCode: 0, stdout, stderr: "" })
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
        let clock = 1_000
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
              stderr: "",
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 5_000,
          nowMs: () => clock,
        }).pipe(Layer.provide(keymaxxerLayer))

        const counts = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          clock += 1_000
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
        let clock = 10_000
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
              stderr: "",
            })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 5_000,
          nowMs: () => clock,
        }).pipe(Layer.provide(keymaxxerLayer))

        const counts = yield* Effect.gen(function* () {
          const github = yield* GitHubService
          const first = yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          clock += 5_000
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
        let clock = 100
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
              return Effect.succeed({ exitCode: 2, stdout: "", stderr: "" })
            }
            return Effect.succeed({ exitCode: 0, stdout: "0", stderr: "" })
          },
        })
        const layer = keymaxxerGitHubLayer({
          workspaceRoot: "/workspace",
          openPullRequestCountFreshnessMs: 60_000,
          nowMs: () => clock,
        }).pipe(Layer.provide(keymaxxerLayer))

        yield* Effect.gen(function* () {
          const github = yield* GitHubService

          const requestFailure = yield* Effect.exit(
            github.countOpenNonDraftPullRequests(acmeWidgets),
          )
          expect(Exit.isFailure(requestFailure)).toBe(true)

          clock += 10
          const unavailable = yield* Effect.exit(
            github.countOpenNonDraftPullRequests(acmeWidgets),
          )
          expect(Exit.isFailure(unavailable)).toBe(true)
          if (Exit.isFailure(unavailable)) {
            const error = unavailable.cause
            // Ensure we did not swallow unavailable into a cached zero.
            expect(String(error)).toContain("GitHubRepositoryUnavailableError")
          }

          clock += 10
          const zero = yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          expect(zero).toBe(0)

          clock += 10
          // Genuine zero is success-cached; failures above must not have been.
          const cachedZero =
            yield* github.countOpenNonDraftPullRequests(acmeWidgets)
          expect(cachedZero).toBe(0)
        }).pipe(Effect.provide(layer))

        expect(runs).toHaveLength(3)
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
            return Effect.succeed({ exitCode: 0, stdout: "5", stderr: "" })
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
})
