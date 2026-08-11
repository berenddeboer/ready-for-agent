import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunServices } from "@effect/platform-bun"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { expandBareHostFlag } from "../../harness/src/server/listen-host.ts"
import { cli } from "./cli.ts"
import {
  HARNESS_START_HINT,
  harnessNotRunningMessage,
} from "./graphql-error.ts"
import { GraphqlApi, GraphqlRequestFailed } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"
import {
  StartHarness,
  type StartHarnessOptions,
} from "./services/start-harness.ts"

/** Package root (`apps/ready-for-agent`), independent of Bun's `import.meta.dir`. */
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

const runOperator = (
  args: ReadonlyArray<string>,
  layer: Layer.Layer<GraphqlApi | LocalGit | StartHarness, never, never>,
) =>
  // Mirror main.ts: expand bare `--host` before Effect's string flag parser.
  Command.runWith(cli, { version: "0.0.0" })(expandBareHostFlag(args)).pipe(
    Effect.provide(layer),
    Effect.provide(BunServices.layer),
  )

describe("operator binary CLI seam", () => {
  let started = 0
  let lastStartOptions: StartHarnessOptions | undefined
  let tempRoot = ""

  beforeEach(() => {
    started = 0
    lastStartOptions = undefined
    tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-cli-"))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const mockStart = Layer.succeed(StartHarness, {
    start: (options) =>
      Effect.sync(() => {
        started += 1
        lastStartOptions = options ?? {}
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

  it.live(
    "add reports GraphQL harness-not-running failures from the service",
    () =>
      Effect.gen(function* () {
        const harnessDown = harnessNotRunningMessage()
        const layer = mockStart.pipe(
          Layer.provideMerge(mockLocalGit),
          Layer.provideMerge(
            Layer.succeed(GraphqlApi, {
              addRepository: () =>
                Effect.fail(
                  new GraphqlRequestFailed({
                    message: harnessDown,
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
          expect(result.message).toBe(harnessDown)
          expect(result.message).toContain(HARNESS_START_HINT)
          expect(result.message).not.toContain("Unable to connect")
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
                  forge: repository.forge,
                  forgeHost: repository.forgeHost,
                  projectPath: repository.projectPath,
                  localPath: repository.localPath,
                  isBare: repository.isBare,
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

  it.live("add success output does not mention paused", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }

      try {
        const layer = mockStart.pipe(
          Layer.provideMerge(mockLocalGit),
          Layer.provideMerge(
            Layer.succeed(GraphqlApi, {
              addRepository: (repository) =>
                Effect.succeed({
                  id: "repo-1",
                  forge: repository.forge,
                  forgeHost: repository.forgeHost,
                  projectPath: repository.projectPath,
                  localPath: repository.localPath,
                  isBare: repository.isBare,
                }),
            }),
          ),
        )

        yield* runOperator(["add", "/tmp/repo"], layer)

        const output = logs.join("\n")
        expect(output).toContain("Added repository owner/repo")
        expect(output).toContain("id: repo-1")
        expect(output).toContain("local path: /tmp/repo")
        expect(output).toContain("bare: false")
        expect(output).not.toMatch(/paused/i)
      } finally {
        console.log = originalLog
      }
    }),
  )

  it("binary help lists start, add, --no-open, and --host", () => {
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
    expect(output).toContain("host")
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

  it.live("default and start accept --host (bare and with address)", () =>
    Effect.gen(function* () {
      const layer = mockStart.pipe(
        Layer.provideMerge(mockLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            addRepository: () => Effect.die("graphql should not run for start"),
          }),
        ),
      )

      yield* runOperator(["--host"], layer)
      expect(started).toBe(1)
      expect(lastStartOptions).toEqual({ noOpen: false, host: "0.0.0.0" })

      yield* runOperator(["start", "--host", "192.168.1.10"], layer)
      expect(started).toBe(2)
      expect(lastStartOptions).toEqual({
        noOpen: false,
        host: "192.168.1.10",
      })

      yield* runOperator(["start", "--host", "0.0.0.0", "--no-open"], layer)
      expect(started).toBe(3)
      expect(lastStartOptions).toEqual({
        noOpen: true,
        host: "0.0.0.0",
      })
    }),
  )

  it("binary add against unreachable GraphQL prints harness-not-running once, no stack", () => {
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
    expect(output).toContain("Harness is not running at http://127.0.0.1:1")
    expect(output).toContain(HARNESS_START_HINT)
    expect(output.split(HARNESS_START_HINT).length - 1).toBe(1)
    expect(output).not.toContain("Unable to connect")
    expect(output).not.toContain("access the url")
    // No multi-frame Effect / internal stack for this expected case.
    expect(output).not.toMatch(/\s+at\s+\S+\s+\(/)
    expect(output).not.toContain("GraphqlRequestFailed:")
    // Child process must not boot the harness (add is GraphQL-only). Do not
    // assert parent `started` — that counter is only for in-process mockStart.
    expect(output.toLowerCase()).not.toContain("starting harness")
  })
})
