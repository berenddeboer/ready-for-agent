import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { BunServices } from "@effect/platform-bun"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { expandBareHostFlag } from "../../harness/src/server/listen-host.ts"
import { cli } from "./cli.ts"
import {
  CLI_SCHEMA_VERSION,
  FiniteCommandFailed,
  buildAddSuccessDocument,
  encodeCompactJson,
} from "./cli-json.ts"
import {
  HARNESS_START_HINT,
  HARNESS_UNREACHABLE_CODE,
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

  beforeEach(() => {
    started = 0
    lastStartOptions = undefined
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
    "add maps GraphQL harness-not-running failures to FiniteCommandFailed",
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
                    code: HARNESS_UNREACHABLE_CODE,
                    message: harnessDown,
                  }),
                ),
            }),
          ),
        )

        const result = yield* runOperator(["add", "/tmp/repo"], layer).pipe(
          Effect.flip,
        )

        expect(result._tag).toBe("FiniteCommandFailed")
        if (result._tag === "FiniteCommandFailed") {
          expect(result.command).toBe("add")
          expect(result.code).toBe(HARNESS_UNREACHABLE_CODE)
          expect(result.message).toBe(harnessDown)
          expect(result.message).toContain(HARNESS_START_HINT)
          expect(result.message).not.toContain("Unable to connect")
        }
      }),
  )

  it.live("add preserves GraphQL domain error codes", () =>
    Effect.gen(function* () {
      const layer = mockStart.pipe(
        Layer.provideMerge(mockLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            addRepository: () =>
              Effect.fail(
                new GraphqlRequestFailed({
                  code: "REPOSITORY_ALREADY_EXISTS",
                  message: "Repository owner/repo already exists on github.com",
                }),
              ),
          }),
        ),
      )

      const result = yield* runOperator(["add", "/tmp/repo"], layer).pipe(
        Effect.flip,
      )

      expect(result).toBeInstanceOf(FiniteCommandFailed)
      if (result instanceof FiniteCommandFailed) {
        expect(result.document).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "add",
          error: {
            code: "REPOSITORY_ALREADY_EXISTS",
            message: "Repository owner/repo already exists on github.com",
          },
        })
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

  it.live("add success emits exactly one versioned JSON document", () =>
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

        expect(logs).toHaveLength(1)
        const expected = buildAddSuccessDocument({
          id: "repo-1",
          forge: "github",
          forgeHost: "github.com",
          projectPath: "owner/repo",
          localPath: "/tmp/repo",
          isBare: false,
        })
        expect(logs[0]).toBe(encodeCompactJson(expected))
        expect(logs[0]).not.toMatch(/paused/i)
        expect(logs[0]).not.toContain("Added repository")
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
})
