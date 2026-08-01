import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunServices } from "@effect/platform-bun"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { cli } from "./cli.ts"
import { HARNESS_START_HINT } from "./graphql-error.ts"
import { GraphqlApi, GraphqlRequestFailed } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"
import { StartHarness } from "./services/start-harness.ts"

/** Package root (`apps/ready-for-agent`), independent of Bun's `import.meta.dir`. */
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

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
    start: () =>
      Effect.sync(() => {
        started += 1
      }),
  })

  const mockLocalGit = Layer.succeed(LocalGit, {
    inspect: (path) =>
      Effect.succeed({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "owner/repo",
        localPath: path,
        isBare: false,
        paused: true as const,
      }),
  })

  it.live("default and start invoke the harness start seam", () =>
    Effect.gen(function* () {
      const layer = mockStart.pipe(
        Layer.provideMerge(mockLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            addRepository: () => Effect.die("graphql should not run for start"),
          }),
        ),
      )

      yield* runOperator([], layer)
      expect(started).toBe(1)

      yield* runOperator(["start"], layer)
      expect(started).toBe(2)
    }),
  )

  it.live("add reports GraphQL start-hint failures from the service", () =>
    Effect.gen(function* () {
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
          }),
        ),
      )

      const result = yield* runOperator(["add", "/tmp/repo"], layer).pipe(
        Effect.flip,
      )

      expect(result._tag).toBe("GraphqlRequestFailed")
      if (result._tag === "GraphqlRequestFailed") {
        expect(result.message).toContain(HARNESS_START_HINT)
      }
    }),
  )

  it.live("add lets the operator correct a guessed GitLab identity", () =>
    Effect.gen(function* () {
      let added:
        | {
            readonly forgeHost: string
            readonly projectPath: string
          }
        | undefined
      const gitlabLocalGit = Layer.succeed(LocalGit, {
        inspect: (path) =>
          Effect.succeed({
            forge: "gitlab" as const,
            forgeHost: "git.drupal.org",
            projectPath: "project/oauth_client",
            localPath: path,
            isBare: false,
            paused: true as const,
          }),
      })
      const layer = mockStart.pipe(
        Layer.provideMerge(gitlabLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            addRepository: (repository) =>
              Effect.sync(() => {
                added = repository
                return {
                  id: "repo-1",
                  ...repository,
                }
              }),
          }),
        ),
      )

      yield* runOperator(
        [
          "add",
          "--forge-host",
          "git.drupalcode.org",
          "--project-path",
          "project/oauth_client",
          "/tmp/repo",
        ],
        layer,
      )

      expect(added).toMatchObject({
        forgeHost: "git.drupalcode.org",
        projectPath: "project/oauth_client",
      })
    }),
  )

  it("binary help lists start, add, and --no-open", () => {
    const result = spawnSync(
      "bun",
      ["--conditions", "@ready-for-agent/source", "src/main.ts", "--help"],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    )

    const output = `${result.stdout}\n${result.stderr}`
    expect(result.status).toBe(0)
    expect(output).toContain("start")
    expect(output).toContain("add")
    expect(output).not.toContain("remove-github-token")
    expect(output).toContain("no-open")
  })

  it.live(
    "default and start accept --no-open without starting GraphQL commands",
    () =>
      Effect.gen(function* () {
        const layer = mockStart.pipe(
          Layer.provideMerge(mockLocalGit),
          Layer.provideMerge(
            Layer.succeed(GraphqlApi, {
              addRepository: () =>
                Effect.die("graphql should not run for start"),
            }),
          ),
        )

        yield* runOperator(["--no-open"], layer)
        expect(started).toBe(1)

        yield* runOperator(["start", "--no-open"], layer)
        expect(started).toBe(2)
      }),
  )

  it("binary add against unreachable GraphQL prints start hint", () => {
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
        cwd: packageRoot,
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
