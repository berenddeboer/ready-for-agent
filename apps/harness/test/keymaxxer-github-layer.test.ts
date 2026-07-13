import { Effect, Layer } from "effect"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
import { keymaxxerGitHubLayer } from "../src/server/keymaxxer-github-layer.js"
import { describe, expect, test } from "bun:test"

describe("Keymaxxer-backed GitHub layer", () => {
  test("obtains GITHUB_TOKEN through Keymaxxer for every GitHub query", async () => {
    const runs: RunWithSecretsInput[] = []
    let tokenChecks = 0
    let tokenPresent = false
    let tokenAdds = 0
    const keymaxxerLayer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      hasSecret: () =>
        Effect.sync(() => {
          tokenChecks += 1
          return tokenPresent
        }),
      addSecret: () =>
        Effect.sleep("10 millis").pipe(
          Effect.map(() => {
            tokenAdds += 1
            tokenPresent = true
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
              parent: {
                number: 1,
                url: "https://github.com/acme/widgets/issues/1",
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
    })
    expect(runs).toHaveLength(2)
    expect(tokenChecks).toBe(2)
    expect(tokenAdds).toBe(1)
    expect(runs.map(({ secrets }) => secrets)).toEqual([
      ["GITHUB_TOKEN"],
      ["GITHUB_TOKEN"],
    ])
    expect(runs[0]?.command).toContain("list-ready-issues.ts")
    expect(runs[0]?.command).not.toContain("Ready issue")
  })
})
