import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { cli } from "./cli.ts"
import { HARNESS_START_HINT } from "./graphql-error.ts"
import { GraphqlApi, GraphqlRequestFailed } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"
import { StartHarness } from "./services/start-harness.ts"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

const runOperator = (
  args: ReadonlyArray<string>,
  layer: Layer.Layer<GraphqlApi | LocalGit | StartHarness, never, never>,
) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(layer),
    Effect.provide(BunServices.layer),
  )

describe("operator binary CLI seam", () => {
  let started = 0
  let tempRoot = ""

  beforeEach(() => {
    started = 0
    tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-cli-"))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const mockStart = Layer.succeed(StartHarness, {
    start: Effect.sync(() => {
      started += 1
    }),
  })

  const mockLocalGit = Layer.succeed(LocalGit, {
    inspect: (path) =>
      Effect.succeed({
        githubOwner: "owner",
        githubRepo: "repo",
        localPath: path,
        isBare: false,
        paused: true as const,
      }),
  })

  test("default and start invoke the harness start seam", async () => {
    const layer = mockStart.pipe(
      Layer.provideMerge(mockLocalGit),
      Layer.provideMerge(
        Layer.succeed(GraphqlApi, {
          addRepository: () => Effect.die("graphql should not run for start"),
          listRepositories: Effect.die("graphql should not run for start"),
          removeRepositoryGitHubToken: () =>
            Effect.die("graphql should not run for start"),
        }),
      ),
    )

    await Effect.runPromise(runOperator([], layer))
    expect(started).toBe(1)

    await Effect.runPromise(runOperator(["start"], layer))
    expect(started).toBe(2)
  })

  test("add reports GraphQL start-hint failures from the service", async () => {
    const layer = mockStart.pipe(
      Layer.provideMerge(mockLocalGit),
      Layer.provideMerge(
        Layer.succeed(GraphqlApi, {
          addRepository: () =>
            Effect.fail(
              new GraphqlRequestFailed({
                message: `Unable to connect\n\n${HARNESS_START_HINT}`,
              }),
            ),
          listRepositories: Effect.die("unused"),
          removeRepositoryGitHubToken: () => Effect.die("unused"),
        }),
      ),
    )

    const result = await Effect.runPromise(
      runOperator(["add", "/tmp/repo"], layer).pipe(Effect.flip),
    )

    expect(result._tag).toBe("GraphqlRequestFailed")
    if (result._tag === "GraphqlRequestFailed") {
      expect(result.message).toContain(HARNESS_START_HINT)
    }
  })

  test("binary help lists start, add, and remove-github-token", () => {
    const result = spawnSync(
      "bun",
      ["--conditions", "@ready-for-agent/source", "src/main.ts", "--help"],
      {
        cwd: join(import.meta.dir, ".."),
        encoding: "utf8",
      },
    )

    const output = `${result.stdout}\n${result.stderr}`
    expect(result.status).toBe(0)
    expect(output).toContain("start")
    expect(output).toContain("add")
    expect(output).toContain("remove-github-token")
  })

  test("binary add against unreachable GraphQL prints start hint", () => {
    const repoDir = join(tempRoot, "repo")
    mkdirSync(repoDir)
    writeFileSync(join(repoDir, "README.md"), "fixture\n")
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: repoDir, encoding: "utf8" })
    expect(git(["init"]).status).toBe(0)
    expect(
      git(["remote", "add", "origin", "git@github.com:owner/repo.git"]).status,
    ).toBe(0)

    const result = spawnSync(
      "bun",
      [
        "--conditions",
        "@ready-for-agent/source",
        "src/main.ts",
        "add",
        repoDir,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          READY_FOR_AGENT_GRAPHQL_URL: "http://127.0.0.1:1/graphql",
        },
      },
    )

    const output = `${result.stdout}\n${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(output).toContain(HARNESS_START_HINT)
  })
})
