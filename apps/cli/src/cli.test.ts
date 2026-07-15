import { Effect } from "effect"
import { resolveRepositoryTarget } from "./cli.ts"
import { describe, expect, test } from "bun:test"

const repository = {
  id: "repo-01J00000000000000000000000",
  githubOwner: "berenddeboer",
  githubRepo: "ready-for-agent",
  localPath: "/home/berend/src/ready-for-agent",
  isBare: false,
  paused: true,
}

describe("resolveRepositoryTarget", () => {
  test("resolves owner/repository without inspecting it as a path", async () => {
    let inspected = false

    const result = await Effect.runPromise(
      resolveRepositoryTarget(
        "berenddeboer/ready-for-agent",
        [repository],
        () => {
          inspected = true
          return Effect.die("owner/repository must not be inspected as a path")
        },
      ),
    )

    expect(result).toEqual(repository)
    expect(inspected).toBe(false)
  })
})
