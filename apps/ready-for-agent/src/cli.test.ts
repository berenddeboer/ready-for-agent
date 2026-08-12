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
  buildCandidatesSuccessDocument,
  buildStatusSuccessDocument,
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

const unusedGraphql = {
  addRepository: () => Effect.die("addRepository should not run"),
  listRepositories: Effect.die("listRepositories should not run"),
  intakeCandidates: () => Effect.die("intakeCandidates should not run"),
  kanbanStatus: () => Effect.die("kanbanStatus should not run"),
} as const

const emptyStatusLanes = [
  { id: "QUEUE" as const, label: "Queue", count: 0, workItems: [] },
  { id: "BUILD" as const, label: "Build", count: 0, workItems: [] },
  { id: "REVIEW" as const, label: "Review", count: 0, workItems: [] },
  { id: "PR" as const, label: "PR", count: 0, workItems: [] },
  { id: "ATTENTION" as const, label: "Attention", count: 0, workItems: [] },
  { id: "MERGED" as const, label: "Merged", count: 0, workItems: [] },
]

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
            ...unusedGraphql,
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
              ...unusedGraphql,
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
            ...unusedGraphql,
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
            ...unusedGraphql,
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
              ...unusedGraphql,
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

  it.live("candidates emits versioned JSON with ordered actions", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }

      try {
        let requestedId: string | undefined
        const layer = mockStart.pipe(
          Layer.provideMerge(mockLocalGit),
          Layer.provideMerge(
            Layer.succeed(GraphqlApi, {
              ...unusedGraphql,
              listRepositories: Effect.succeed([
                {
                  id: "repo-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "Owner/Repo",
                },
              ]),
              intakeCandidates: (repositoryId) =>
                Effect.sync(() => {
                  requestedId = repositoryId
                  return {
                    repository: {
                      id: "repo-1",
                      forge: "github",
                      forgeHost: "github.com",
                      projectPath: "Owner/Repo",
                      issuesReconciledAt: "2026-08-12T10:00:00.000Z",
                    },
                    candidates: [
                      {
                        issueNumber: 7,
                        title: "Ready work",
                        url: "https://github.com/Owner/Repo/issues/7",
                        action: "IMPLEMENT_NOW" as const,
                      },
                      {
                        issueNumber: 9,
                        title: "Blocked work",
                        url: "https://github.com/Owner/Repo/issues/9",
                        action: "QUEUE" as const,
                      },
                    ],
                  }
                }),
            }),
          ),
        )

        yield* runOperator(["candidates", "GitHub.com/owner/repo"], layer)

        expect(requestedId).toBe("repo-1")
        expect(logs).toHaveLength(1)
        expect(logs[0]).toBe(
          encodeCompactJson(
            buildCandidatesSuccessDocument({
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "Owner/Repo",
              },
              issuesReconciledAt: "2026-08-12T10:00:00.000Z",
              candidates: [
                {
                  issueNumber: 7,
                  title: "Ready work",
                  url: "https://github.com/Owner/Repo/issues/7",
                  action: "IMPLEMENT_NOW",
                },
                {
                  issueNumber: 9,
                  title: "Blocked work",
                  url: "https://github.com/Owner/Repo/issues/9",
                  action: "QUEUE",
                },
              ],
            }),
          ),
        )
      } finally {
        console.log = originalLog
      }
    }),
  )

  it.live("candidates empty list succeeds with null issuesReconciledAt", () =>
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
              ...unusedGraphql,
              listRepositories: Effect.succeed([
                {
                  id: "repo-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "owner/repo",
                },
              ]),
              intakeCandidates: () =>
                Effect.succeed({
                  repository: {
                    id: "repo-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                    issuesReconciledAt: null,
                  },
                  candidates: [],
                }),
            }),
          ),
        )

        yield* runOperator(["candidates", "github.com/owner/repo"], layer)

        expect(logs).toHaveLength(1)
        expect(JSON.parse(logs[0] ?? "")).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "candidates",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          issuesReconciledAt: null,
          candidates: [],
        })
      } finally {
        console.log = originalLog
      }
    }),
  )

  it.live("candidates fails when no configured Repository matches", () =>
    Effect.gen(function* () {
      const layer = mockStart.pipe(
        Layer.provideMerge(mockLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            ...unusedGraphql,
            listRepositories: Effect.succeed([]),
          }),
        ),
      )

      const result = yield* runOperator(
        ["candidates", "github.com/missing/repo"],
        layer,
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(FiniteCommandFailed)
      if (result instanceof FiniteCommandFailed) {
        expect(result.document).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "candidates",
          error: {
            code: "REPOSITORY_NOT_FOUND",
            message: "No configured Repository matches github.com/missing/repo",
          },
        })
      }
    }),
  )

  it.live("candidates preserves GraphQL preflight error codes", () =>
    Effect.gen(function* () {
      const layer = mockStart.pipe(
        Layer.provideMerge(mockLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            ...unusedGraphql,
            listRepositories: Effect.succeed([
              {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "owner/repo",
              },
            ]),
            intakeCandidates: () =>
              Effect.fail(
                new GraphqlRequestFailed({
                  code: "AGENT_BACKEND_UNAVAILABLE",
                  message: "Agent Backend is unavailable",
                }),
              ),
          }),
        ),
      )

      const result = yield* runOperator(
        ["candidates", "github.com/owner/repo"],
        layer,
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(FiniteCommandFailed)
      if (result instanceof FiniteCommandFailed) {
        expect(result.document).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "candidates",
          error: {
            code: "AGENT_BACKEND_UNAVAILABLE",
            message: "Agent Backend is unavailable",
          },
        })
      }
    }),
  )

  it.live("status without repository returns all-sources Kanban JSON", () =>
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
              ...unusedGraphql,
              kanbanStatus: (repositoryId) => {
                expect(repositoryId).toBeNull()
                return Effect.succeed({
                  repository: null,
                  lanes: emptyStatusLanes,
                })
              },
            }),
          ),
        )

        yield* runOperator(["status"], layer)

        expect(logs).toHaveLength(1)
        expect(logs[0]).toBe(
          encodeCompactJson(
            buildStatusSuccessDocument({
              repository: null,
              lanes: emptyStatusLanes,
            }),
          ),
        )
      } finally {
        console.log = originalLog
      }
    }),
  )

  it.live("status with repository selector scopes GraphQL by resolved id", () =>
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
              ...unusedGraphql,
              listRepositories: Effect.succeed([
                {
                  id: "repo-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "Owner/Repo",
                },
              ]),
              kanbanStatus: (repositoryId) => {
                expect(repositoryId).toBe("repo-1")
                return Effect.succeed({
                  repository: {
                    id: "repo-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "Owner/Repo",
                  },
                  lanes: emptyStatusLanes,
                })
              },
            }),
          ),
        )

        yield* runOperator(["status", "GitHub.COM/owner/repo"], layer)

        expect(logs).toHaveLength(1)
        expect(JSON.parse(logs[0]!)).toMatchObject({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "status",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "Owner/Repo",
          },
        })
      } finally {
        console.log = originalLog
      }
    }),
  )

  it.live("status fails with REPOSITORY_NOT_FOUND for unknown selector", () =>
    Effect.gen(function* () {
      const layer = mockStart.pipe(
        Layer.provideMerge(mockLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            ...unusedGraphql,
            listRepositories: Effect.succeed([]),
          }),
        ),
      )

      const result = yield* runOperator(
        ["status", "github.com/missing/repo"],
        layer,
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(FiniteCommandFailed)
      if (result instanceof FiniteCommandFailed) {
        expect(result.document).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "status",
          error: {
            code: "REPOSITORY_NOT_FOUND",
            message: "No configured Repository matches github.com/missing/repo",
          },
        })
      }
    }),
  )

  it("binary help lists start, add, candidates, status, --no-open, and --host", () => {
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
    expect(output).toContain("candidates")
    expect(output).toContain("status")
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
              ...unusedGraphql,
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
            ...unusedGraphql,
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
