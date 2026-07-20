import { Effect, Layer } from "effect"
import {
  GitHubRequestError,
  GitHubService,
} from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
import { keymaxxerGitHubLayer } from "../src/server/keymaxxer-github-layer.js"
import { describe, expect, test } from "bun:test"

describe("Keymaxxer-backed GitHub layer", () => {
  test("does not prompt Keymaxxer when a repository token is missing", async () => {
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
    const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* Effect.exit(
          github.listReadyIssues({ owner: "foo-bar", name: "baz" }),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Failure")
    expect(addCalled).toBe(false)
    expect(runs).toHaveLength(0)
  })

  test("selects colliding token names by Repository account", async () => {
    const runs: RunWithSecretsInput[] = []
    const tokens = new Map([
      ["foo-bar/baz", "TOKEN_FOR_FIRST_REPOSITORY"],
      ["foo/bar-baz", "TOKEN_FOR_SECOND_REPOSITORY"],
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
    const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        yield* github.listReadyIssues({ owner: "foo-bar", name: "baz" })
        yield* github.listReadyIssues({ owner: "foo", name: "bar-baz" })
      }).pipe(Effect.provide(layer)),
    )

    expect(runs.map(({ secrets }) => secrets)).toEqual([
      ["TOKEN_FOR_FIRST_REPOSITORY"],
      ["TOKEN_FOR_SECOND_REPOSITORY"],
    ])
  })

  test("obtains the configured repository GitHub token through Keymaxxer", async () => {
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

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* Effect.all(
          [
            github.listReadyIssues({ owner: "acme", name: "widgets" }),
            github.listReadyIssues({ owner: "acme", name: "widgets" }),
          ],
          { concurrency: "unbounded" },
        )
      }).pipe(Effect.provide(layer)),
    )

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
    expect(runs[0]?.command).toStartWith(
      'GITHUB_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS" ',
    )
    expect(runs[0]?.command).toContain("list-ready-issues.ts")
    expect(runs[0]?.command).toMatch(
      /"--conditions" "@ready-for-agent\/source" "\/.*list-ready-issues\.ts"/,
    )
    expect(runs[0]?.command).not.toContain(
      "--ready-for-agent-internal-github-helper",
    )
    expect(runs[0]?.cwd).toBe("/workspace")
    expect(runs[0]?.command).not.toContain("Ready issue")
  })

  test("checks a PR branch through the configured repository token", async () => {
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

    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getPullRequestCheckStatus(
          { owner: "acme", name: "widgets" },
          "rfa/acme-widgets/42/wi-test",
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(status).toEqual({
      _tag: "failed",
      mergeability: "conflicting",
      baseRefName: "develop",
      headPushedAt: null,
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
  })

  test("resolves an open PR number through the configured repository token", async () => {
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
    const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
    )

    const number = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getOpenPullRequestNumber(
          { owner: "acme", name: "widgets" },
          "rfa/acme-widgets/42/wi-test",
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(number).toBe(321)
    expect(runs[0]?.command).toContain("get-open-pr-number.ts")
    expect(runs[0]?.command).toContain('"--conditions"')
  })

  test("decodes no_checks and pending terminalChecks from the bin", async () => {
    const responses = [
      JSON.stringify({
        _tag: "no_checks",
        mergeability: "mergeable",
        baseRefName: "main",
        headPushedAt: null,
      }),
      JSON.stringify({
        _tag: "pending",
        mergeability: "unknown",
        baseRefName: "main",
        headPushedAt: null,
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

    const noChecks = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getPullRequestCheckStatus(
          { owner: "acme", name: "widgets" },
          "branch",
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(noChecks).toEqual({
      _tag: "no_checks",
      mergeability: "mergeable",
      baseRefName: "main",
      headPushedAt: null,
    })

    const pending = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github.getPullRequestCheckStatus(
          { owner: "acme", name: "widgets" },
          "branch",
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(pending).toEqual({
      _tag: "pending",
      mergeability: "unknown",
      baseRefName: "main",
      headPushedAt: null,
      terminalChecks: [
        {
          externalId: "status:SC_ci",
          name: "ci",
          outcome: "green",
        },
      ],
    })
  })

  test("marks a PR ready for review through the configured repository token", async () => {
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
    const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        yield* github.markPullRequestReadyForReview(
          { owner: "acme", name: "widgets" },
          "rfa/acme-widgets/42/wi-test",
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(runs[0]?.command).toContain("mark-pr-ready-for-review.ts")
    expect(runs[0]?.command).toContain('"--conditions"')
    expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
  })

  test("sanitizes ANSI Effect dumps from CLI stderr into plain GitHubRequestError messages", async () => {
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
    const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
    )

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github
          .getPullRequestCheckStatus(
            { owner: "processfocus", name: "monorepo" },
            "branch",
          )
          .pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect(error.message).toBe(
      "Failed to get pull request check status for processfocus/monorepo: HTTP 401: Bad credentials",
    )
    expect(error.message.includes(`${esc}[`)).toBe(false)
    expect(error.message).not.toContain("_tag")
  })

  test("merges a PR through the configured repository token", async () => {
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
          stdout: JSON.stringify({ _tag: "merged" }),
          stderr: "",
        })
      },
    })
    const layer = keymaxxerGitHubLayer({ workspaceRoot: "/workspace" }).pipe(
      Layer.provide(keymaxxerLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        yield* github.mergePullRequest(
          { owner: "acme", name: "widgets" },
          "rfa/acme-widgets/42/wi-test",
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(runs[0]?.command).toContain("merge-pull-request.ts")
    expect(runs[0]?.command).toContain('"--conditions"')
    expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
  })

  test("rejects malformed Ready Issue fields through Schema", async () => {
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

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHubService
        return yield* github
          .listReadyIssues({ owner: "acme", name: "widgets" })
          .pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect(error.message).toBe(
      "Failed to list Ready-labeled Issues for acme/widgets",
    )
  })
})
