import { Effect, Layer } from "effect"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
import { keymaxxerGitHubLayer } from "../src/server/keymaxxer-github-layer.js"
import { describe, expect, test } from "bun:test"

describe("Keymaxxer-backed GitHub layer", () => {
  test("does not guess when the suggested token name is occupied", async () => {
    const checkedNames: string[] = []
    let addCalled = false
    const runs: RunWithSecretsInput[] = []
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.succeed(null),
      hasSecret: (name) =>
        Effect.sync(() => {
          checkedNames.push(name)
          return true
        }),
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
    expect(checkedNames).toEqual(["GITHUB_TOKEN_FOO_BAR_BAZ"])
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

  test("obtains the repository GitHub token through Keymaxxer", async () => {
    const runs: RunWithSecretsInput[] = []
    const tokenChecks: string[] = []
    let tokenPresent = false
    let tokenAccount: string | null = null
    let tokenName: string | null = null
    const tokenAdds: string[] = []
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: ({ account }) =>
        Effect.succeed(account === tokenAccount ? tokenName : null),
      hasSecret: (name) =>
        Effect.sync(() => {
          tokenChecks.push(name)
          return tokenPresent
        }),
      addSecret: ({ account, name }) =>
        Effect.sleep("10 millis").pipe(
          Effect.map(() => {
            tokenAdds.push(name)
            tokenPresent = true
            tokenAccount = account ?? null
            tokenName = name
            return true
          }),
        ),
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
    expect(tokenChecks).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
    expect(tokenAdds).toEqual(["GITHUB_TOKEN_ACME_WIDGETS"])
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
})
