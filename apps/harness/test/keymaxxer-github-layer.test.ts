import { Effect, Layer } from "effect"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
import { keymaxxerGitHubLayer } from "../src/server/keymaxxer-github-layer.js"
import { describe, expect, test } from "bun:test"

describe("Keymaxxer-backed GitHub layer", () => {
  test("uses ambient GitHub authentication when Keymaxxer is disabled", async () => {
    const runs: RunWithSecretsInput[] = []
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      enabled: false,
      initialize: Effect.void,
      findSecret: () => Effect.die("must not inspect the vault"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      removeSecret: () => Effect.die("not used"),
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
        yield* github.listReadyIssues({ owner: "acme", name: "widgets" })
      }).pipe(Effect.provide(layer)),
    )

    expect(runs).toHaveLength(1)
    expect(runs[0]?.secrets).toEqual([])
    expect(runs[0]?.command).toContain("gh auth token")
    expect(runs[0]?.command.toLowerCase()).not.toContain("keymaxxer")
  })

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
      removeSecret: () => Effect.die("not used"),
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
      removeSecret: () => Effect.die("not used"),
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
      removeSecret: () => Effect.die("not used"),
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
      removeSecret: () => Effect.die("not used"),
      runWithSecrets: (input) => {
        runs.push(input)
        return Effect.succeed({
          exitCode: 0,
          stdout: JSON.stringify({
            _tag: "failed",
            mergeability: "conflicting",
            baseRefName: "develop",
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
      terminalChecks: [
        {
          externalId: "checkrun:1",
          name: "lint",
          outcome: "red",
        },
      ],
    })
    expect(runs[0]?.command).toContain("get-pr-check-status.ts")
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
      removeSecret: () => Effect.die("not used"),
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
  })

  test("decodes no_checks and pending terminalChecks from the bin", async () => {
    const responses = [
      JSON.stringify({
        _tag: "no_checks",
        mergeability: "mergeable",
        baseRefName: "main",
      }),
      JSON.stringify({
        _tag: "pending",
        mergeability: "unknown",
        baseRefName: "main",
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
      removeSecret: () => Effect.die("not used"),
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
    expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
  })

  test("merges a PR through the configured repository token", async () => {
    const runs: RunWithSecretsInput[] = []
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      removeSecret: () => Effect.die("not used"),
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
    expect(runs[0]?.secrets).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
  })
})
