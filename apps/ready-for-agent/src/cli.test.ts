import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunServices } from "@effect/platform-bun"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { expandBareHostFlag } from "../../harness/src/server/listen-host.ts"
import { cli } from "./cli.ts"
import {
  CLI_SCHEMA_VERSION,
  FiniteCommandFailed,
  buildAddSuccessDocument,
  buildCandidatesSuccessDocument,
  buildIntakeSuccessDocument,
  buildRetrySuccessDocument,
  buildStatusSuccessDocument,
  encodeCompactJson,
} from "./cli-json.ts"
import {
  HARNESS_START_HINT,
  HARNESS_UNREACHABLE_CODE,
  harnessNotRunningMessage,
} from "./graphql-error.ts"
import { JumpFailed } from "./jump-error.ts"
import {
  type DirectLaunchInput,
  DirectTerminal,
} from "./services/direct-terminal.ts"
import { ExecutablePath } from "./services/executable-path.ts"
import {
  GraphqlApi,
  GraphqlRequestFailed,
  type SessionWorkItemLookup,
} from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"
import {
  StartHarness,
  type StartHarnessOptions,
} from "./services/start-harness.ts"
import { type JumpWindowInput, Tmux } from "./services/tmux.ts"

/** Package root (`apps/ready-for-agent`), independent of Bun's `import.meta.dir`. */
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

const unusedGraphql = {
  addRepository: () => Effect.die("addRepository should not run"),
  listRepositories: Effect.die("listRepositories should not run"),
  intakeCandidates: () => Effect.die("intakeCandidates should not run"),
  startRepositoryIntake: () =>
    Effect.die("startRepositoryIntake should not run"),
  retryWorkItems: () => Effect.die("retryWorkItems should not run"),
  kanbanStatus: () => Effect.die("kanbanStatus should not run"),
  workItemBySessionId: () => Effect.die("workItemBySessionId should not run"),
} as const

const unusedJumpServices = Layer.mergeAll(
  Layer.succeed(Tmux, {
    tmuxModeSelected: Effect.die("tmux should not run"),
    createJumpWindow: () => Effect.die("tmux should not run"),
  }),
  Layer.succeed(DirectTerminal, {
    requireInteractiveTerminal: Effect.die("direct terminal should not run"),
    run: () => Effect.die("direct terminal should not run"),
  }),
  Layer.succeed(ExecutablePath, {
    resolve: () => Effect.die("executable path should not run"),
  }),
)

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
    Effect.provide(unusedJumpServices),
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

  it.live("candidates accepts a unique project-path shorthand", () =>
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
                  projectPath: "berenddeboer/ready-for-agent",
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
                      projectPath: "berenddeboer/ready-for-agent",
                      issuesReconciledAt: null,
                    },
                    candidates: [],
                  }
                }),
            }),
          ),
        )

        yield* runOperator(
          ["candidates", "berenddeboer/ready-for-agent"],
          layer,
        )

        expect(requestedId).toBe("repo-1")
        expect(logs).toHaveLength(1)
        expect(JSON.parse(logs[0] ?? "")).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "candidates",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "berenddeboer/ready-for-agent",
          },
          issuesReconciledAt: null,
          candidates: [],
        })
      } finally {
        console.log = originalLog
      }
    }),
  )

  it.live(
    "candidates fails with REPOSITORY_AMBIGUOUS listing matching identities",
    () =>
      Effect.gen(function* () {
        const layer = mockStart.pipe(
          Layer.provideMerge(mockLocalGit),
          Layer.provideMerge(
            Layer.succeed(GraphqlApi, {
              ...unusedGraphql,
              listRepositories: Effect.succeed([
                {
                  id: "repo-github",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "acme/ready-for-agent",
                },
                {
                  id: "repo-gitlab",
                  forge: "gitlab",
                  forgeHost: "gitlab.com",
                  projectPath: "group/ready-for-agent",
                },
              ]),
            }),
          ),
        )

        const result = yield* runOperator(
          ["candidates", "ready-for-agent"],
          layer,
        ).pipe(Effect.flip)

        expect(result).toBeInstanceOf(FiniteCommandFailed)
        if (result instanceof FiniteCommandFailed) {
          expect(result.document).toEqual({
            schemaVersion: CLI_SCHEMA_VERSION,
            command: "candidates",
            error: {
              code: "REPOSITORY_AMBIGUOUS",
              message:
                "Multiple configured Repositories match ready-for-agent: github.com://acme/ready-for-agent, gitlab.com://group/ready-for-agent",
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

  it.live("intake emits versioned JSON and keeps exit 0 when all created", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      const previousExitCode = process.exitCode
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      process.exitCode = undefined

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
              startRepositoryIntake: (repositoryId) =>
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
                    results: [
                      {
                        issueNumber: 7,
                        title: "Ready work",
                        url: "https://github.com/Owner/Repo/issues/7",
                        action: "IMPLEMENT_NOW" as const,
                        outcome: "CREATED" as const,
                        workItem: {
                          id: "wi-7",
                          state: "CREATE_WORKTREE",
                          status: "QUEUED",
                        },
                      },
                    ],
                  }
                }),
            }),
          ),
        )

        yield* runOperator(["intake", "GitHub.com/owner/repo"], layer)

        expect(requestedId).toBe("repo-1")
        expect(logs).toHaveLength(1)
        expect(logs[0]).toBe(
          encodeCompactJson(
            buildIntakeSuccessDocument({
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "Owner/Repo",
              },
              issuesReconciledAt: "2026-08-12T10:00:00.000Z",
              results: [
                {
                  issueNumber: 7,
                  title: "Ready work",
                  url: "https://github.com/Owner/Repo/issues/7",
                  action: "IMPLEMENT_NOW",
                  outcome: "CREATED",
                  workItem: {
                    id: "wi-7",
                    state: "CREATE_WORKTREE",
                    status: "QUEUED",
                  },
                },
              ],
            }),
          ),
        )
        expect(process.exitCode).toBe(0)
      } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("intake partial failure writes stdout and sets exitCode 1", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      const previousExitCode = process.exitCode
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      process.exitCode = undefined

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
              startRepositoryIntake: () =>
                Effect.succeed({
                  repository: {
                    id: "repo-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                    issuesReconciledAt: null,
                  },
                  results: [
                    {
                      issueNumber: 7,
                      title: "Ready",
                      url: "https://github.com/owner/repo/issues/7",
                      action: "IMPLEMENT_NOW" as const,
                      outcome: "CREATED" as const,
                      workItem: {
                        id: "wi-7",
                        state: "CREATE_WORKTREE",
                        status: "QUEUED",
                      },
                    },
                    {
                      issueNumber: 9,
                      title: "Race",
                      url: "https://github.com/owner/repo/issues/9",
                      action: "QUEUE" as const,
                      outcome: "FAILED" as const,
                      error: {
                        code: "UNFINISHED_WORK_ITEM_EXISTS",
                        message: "Issue #9 already has an unfinished Work Item",
                      },
                    },
                  ],
                }),
            }),
          ),
        )

        yield* runOperator(["intake", "github.com/owner/repo"], layer)

        expect(logs).toHaveLength(1)
        expect(JSON.parse(logs[0] ?? "")).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "intake",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          issuesReconciledAt: null,
          results: [
            {
              issueNumber: 7,
              title: "Ready",
              url: "https://github.com/owner/repo/issues/7",
              action: "IMPLEMENT_NOW",
              outcome: "CREATED",
              workItem: {
                id: "wi-7",
                state: "CREATE_WORKTREE",
                status: "QUEUED",
              },
            },
            {
              issueNumber: 9,
              title: "Race",
              url: "https://github.com/owner/repo/issues/9",
              action: "QUEUE",
              outcome: "FAILED",
              error: {
                code: "UNFINISHED_WORK_ITEM_EXISTS",
                message: "Issue #9 already has an unfinished Work Item",
              },
            },
          ],
        })
        expect(process.exitCode).toBe(1)
      } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("intake empty results succeed without partial exit", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      const previousExitCode = process.exitCode
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      process.exitCode = undefined

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
              startRepositoryIntake: () =>
                Effect.succeed({
                  repository: {
                    id: "repo-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                    issuesReconciledAt: null,
                  },
                  results: [],
                }),
            }),
          ),
        )

        yield* runOperator(["intake", "github.com/owner/repo"], layer)

        expect(JSON.parse(logs[0] ?? "")).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "intake",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          issuesReconciledAt: null,
          results: [],
        })
        expect(process.exitCode).toBe(0)
      } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("retry all-retryable emits versioned JSON and keeps exit 0", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      const previousExitCode = process.exitCode
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      process.exitCode = undefined

      try {
        let requested: { repositoryId: string; selector: unknown } | undefined
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
              retryWorkItems: (repositoryId, selector) =>
                Effect.sync(() => {
                  requested = { repositoryId, selector }
                  return {
                    repository: {
                      id: "repo-1",
                      forge: "github",
                      forgeHost: "github.com",
                      projectPath: "Owner/Repo",
                    },
                    results: [
                      {
                        issueNumber: 7,
                        outcome: "RETRIED" as const,
                        workItem: {
                          id: "wi-7",
                          state: "IMPLEMENT",
                          status: "QUEUED",
                        },
                      },
                    ],
                  }
                }),
            }),
          ),
        )

        yield* runOperator(
          ["retry", "GitHub.com/owner/repo", "--all-retryable"],
          layer,
        )

        expect(requested).toEqual({
          repositoryId: "repo-1",
          selector: { allRetryable: true },
        })
        expect(logs).toHaveLength(1)
        expect(logs[0]).toBe(
          encodeCompactJson(
            buildRetrySuccessDocument({
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "Owner/Repo",
              },
              results: [
                {
                  issueNumber: 7,
                  outcome: "RETRIED",
                  workItem: {
                    id: "wi-7",
                    state: "IMPLEMENT",
                    status: "QUEUED",
                  },
                },
              ],
            }),
          ),
        )
        expect(process.exitCode).toBe(0)
      } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live(
    "retry all-retryable sends --max-autonomous-retries and treats LIMIT_REACHED as nonzero",
    () =>
      Effect.gen(function* () {
        const logs: string[] = []
        const originalLog = console.log
        const previousExitCode = process.exitCode
        console.log = (...args: unknown[]) => {
          logs.push(args.map(String).join(" "))
        }
        process.exitCode = undefined

        try {
          let maxAutonomousRetries: number | undefined
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
                retryWorkItems: (_repositoryId, _selector, maxRetries) =>
                  Effect.sync(() => {
                    maxAutonomousRetries = maxRetries
                    return {
                      repository: {
                        id: "repo-1",
                        forge: "github",
                        forgeHost: "github.com",
                        projectPath: "owner/repo",
                      },
                      results: [
                        {
                          issueNumber: 7,
                          outcome: "LIMIT_REACHED" as const,
                          workItem: {
                            id: "wi-7",
                            state: "IMPLEMENT",
                            status: "FAILED",
                          },
                          reason: {
                            code: "LIMIT_REACHED",
                            message: "Autonomous Retry Budget exhausted (3/3)",
                          },
                        },
                      ],
                    }
                  }),
              }),
            ),
          )

          yield* runOperator(
            [
              "retry",
              "github.com/owner/repo",
              "--all-retryable",
              "--max-autonomous-retries",
              "2",
            ],
            layer,
          )

          expect(maxAutonomousRetries).toBe(2)
          expect(JSON.parse(logs[0] ?? "")).toMatchObject({
            command: "retry",
            results: [{ outcome: "LIMIT_REACHED", issueNumber: 7 }],
          })
          expect(process.exitCode).toBe(1)
        } finally {
          console.log = originalLog
          process.exitCode = previousExitCode
        }
      }),
  )

  it.live("retry --issue targets that Issue's unfinished Work Item", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      const previousExitCode = process.exitCode
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      process.exitCode = undefined

      try {
        let requested: { repositoryId: string; selector: unknown } | undefined
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
              retryWorkItems: (repositoryId, selector) =>
                Effect.sync(() => {
                  requested = { repositoryId, selector }
                  return {
                    repository: {
                      id: "repo-1",
                      forge: "github",
                      forgeHost: "github.com",
                      projectPath: "owner/repo",
                    },
                    results: [
                      {
                        issueNumber: 42,
                        outcome: "SKIPPED" as const,
                        workItem: {
                          id: "wi-42",
                          state: "IMPLEMENT",
                          status: "FAILED",
                        },
                        reason: {
                          code: "RETRY_NOT_ELIGIBLE",
                          message: "Work Item wi-42 cannot be retried: paused",
                        },
                      },
                    ],
                  }
                }),
            }),
          ),
        )

        yield* runOperator(
          ["retry", "github.com/owner/repo", "--issue", "42"],
          layer,
        )

        expect(requested).toEqual({
          repositoryId: "repo-1",
          selector: { issueNumber: 42 },
        })
        expect(JSON.parse(logs[0] ?? "")).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "retry",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          results: [
            {
              issueNumber: 42,
              outcome: "SKIPPED",
              workItem: {
                id: "wi-42",
                state: "IMPLEMENT",
                status: "FAILED",
              },
              reason: {
                code: "RETRY_NOT_ELIGIBLE",
                message: "Work Item wi-42 cannot be retried: paused",
              },
            },
          ],
        })
        expect(process.exitCode).toBe(0)
      } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("retry partial failure writes stdout and sets exitCode 1", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      const previousExitCode = process.exitCode
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      process.exitCode = undefined

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
              retryWorkItems: () =>
                Effect.succeed({
                  repository: {
                    id: "repo-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                  results: [
                    {
                      issueNumber: 7,
                      outcome: "RETRIED" as const,
                      workItem: {
                        id: "wi-7",
                        state: "IMPLEMENT",
                        status: "QUEUED",
                      },
                    },
                    {
                      issueNumber: 9,
                      outcome: "FAILED" as const,
                      workItem: {
                        id: "wi-9",
                        state: "IMPLEMENT",
                        status: "FAILED",
                      },
                      error: {
                        code: "ACTIVE_STEP_RUN_EXISTS",
                        message:
                          "Work Item wi-9 already has an active Step Run",
                      },
                    },
                  ],
                }),
            }),
          ),
        )

        yield* runOperator(
          ["retry", "github.com/owner/repo", "--all-retryable"],
          layer,
        )

        expect(JSON.parse(logs[0] ?? "")).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "retry",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          results: [
            {
              issueNumber: 7,
              outcome: "RETRIED",
              workItem: {
                id: "wi-7",
                state: "IMPLEMENT",
                status: "QUEUED",
              },
            },
            {
              issueNumber: 9,
              outcome: "FAILED",
              workItem: {
                id: "wi-9",
                state: "IMPLEMENT",
                status: "FAILED",
              },
              error: {
                code: "ACTIVE_STEP_RUN_EXISTS",
                message: "Work Item wi-9 already has an active Step Run",
              },
            },
          ],
        })
        expect(process.exitCode).toBe(1)
      } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("retry empty results succeed without partial exit", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      const previousExitCode = process.exitCode
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      process.exitCode = undefined

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
              retryWorkItems: () =>
                Effect.succeed({
                  repository: {
                    id: "repo-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                  results: [],
                }),
            }),
          ),
        )

        yield* runOperator(
          ["retry", "github.com/owner/repo", "--all-retryable"],
          layer,
        )

        expect(JSON.parse(logs[0] ?? "")).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "retry",
          repository: {
            id: "repo-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          results: [],
        })
        expect(process.exitCode).toBe(0)
      } finally {
        console.log = originalLog
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("retry requires exactly one selector", () =>
    Effect.gen(function* () {
      const layer = mockStart.pipe(
        Layer.provideMerge(mockLocalGit),
        Layer.provideMerge(
          Layer.succeed(GraphqlApi, {
            ...unusedGraphql,
          }),
        ),
      )

      const result = yield* runOperator(
        ["retry", "github.com/owner/repo"],
        layer,
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(FiniteCommandFailed)
      if (result instanceof FiniteCommandFailed) {
        expect(result.document).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "retry",
          error: {
            code: "INVALID_RETRY_SELECTOR",
            message:
              "Exactly one of --issue, --work-item, or --all-retryable is required",
          },
        })
      }
    }),
  )

  it.live("retry preserves GraphQL operation-level error codes", () =>
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
            retryWorkItems: () =>
              Effect.fail(
                new GraphqlRequestFailed({
                  code: "WORK_ITEM_NOT_IN_REPOSITORY",
                  message:
                    "Work Item wi-9 does not belong to repository repo-1",
                }),
              ),
          }),
        ),
      )

      const result = yield* runOperator(
        ["retry", "github.com/owner/repo", "--work-item", "wi-9"],
        layer,
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(FiniteCommandFailed)
      if (result instanceof FiniteCommandFailed) {
        expect(result.document).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "retry",
          error: {
            code: "WORK_ITEM_NOT_IN_REPOSITORY",
            message: "Work Item wi-9 does not belong to repository repo-1",
          },
        })
      }
    }),
  )

  it.live("intake preserves GraphQL operation-level error codes", () =>
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
            startRepositoryIntake: () =>
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
        ["intake", "github.com/owner/repo"],
        layer,
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(FiniteCommandFailed)
      if (result instanceof FiniteCommandFailed) {
        expect(result.document).toEqual({
          schemaVersion: CLI_SCHEMA_VERSION,
          command: "intake",
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

  it.live(
    "status carries Harness-owned canRetry and latest Step Run reason",
    () =>
      Effect.gen(function* () {
        const logs: string[] = []
        const originalLog = console.log
        console.log = (...args: unknown[]) => {
          logs.push(args.map(String).join(" "))
        }
        const repository = {
          id: "repo-1",
          forge: "github",
          forgeHost: "github.com",
          projectPath: "owner/repo",
        }
        const attentionRows = [
          {
            repository,
            id: "wi-retryable-failed",
            issueNumber: 10,
            issueTitle: "Retryable implement failure",
            state: "IMPLEMENT",
            status: "FAILED",
            statusMessage:
              "Claude Code failed to implement the Work Item issue",
            paused: false,
            canRetry: true,
            latestStepRunReason: {
              code: "handler_failed",
              message: "Claude Code failed to implement the Work Item issue",
              retryAt: null,
              detail: {
                code: "ENOENT",
                causeChain: [
                  {
                    name: "Error",
                    code: "ENOENT",
                    message: 'ENOENT: Executable not found in $PATH: "claude"',
                  },
                ],
              },
            },
            pullRequestNumber: null,
            createdAt: "2026-08-12T10:00:00.000Z",
            updatedAt: "2026-08-12T10:00:00.000Z",
            stateReadyAt: "2026-08-12T10:00:00.000Z",
            postponedUntil: null,
          },
          {
            repository,
            id: "wi-terminal-failed",
            issueNumber: 11,
            issueTitle: "Terminal close failure",
            state: "FAILED",
            status: "FAILED",
            statusMessage: "Issue is not open",
            paused: false,
            canRetry: false,
            latestStepRunReason: {
              code: "issue_not_open",
              message: "Issue is not open",
              detail: null,
              retryAt: null,
            },
            pullRequestNumber: null,
            createdAt: "2026-08-12T10:00:00.000Z",
            updatedAt: "2026-08-12T10:00:00.000Z",
            stateReadyAt: "2026-08-12T10:00:00.000Z",
            postponedUntil: null,
          },
          {
            repository,
            id: "wi-retryable-needs-human",
            issueNumber: 12,
            issueTitle: "Retryable review handoff",
            state: "NEEDS_HUMAN",
            status: "NEEDS_HUMAN",
            statusMessage: "Human must review findings",
            paused: false,
            canRetry: true,
            latestStepRunReason: {
              code: "review_accepted",
              message: "Human must review findings",
              detail: null,
              retryAt: null,
            },
            pullRequestNumber: null,
            createdAt: "2026-08-12T10:00:00.000Z",
            updatedAt: "2026-08-12T10:00:00.000Z",
            stateReadyAt: "2026-08-12T10:00:00.000Z",
            postponedUntil: null,
          },
          {
            repository,
            id: "wi-unavailable-detail",
            issueNumber: 13,
            issueTitle: "Interrupted without detail",
            state: "IMPLEMENT",
            status: "INTERRUPTED",
            statusMessage:
              "Lifecycle Step was interrupted before an outcome could be established",
            paused: false,
            canRetry: true,
            latestStepRunReason: {
              code: "interrupted",
              message:
                "Lifecycle Step was interrupted before an outcome could be established",
              detail: null,
              retryAt: null,
            },
            pullRequestNumber: null,
            createdAt: "2026-08-12T10:00:00.000Z",
            updatedAt: "2026-08-12T10:00:00.000Z",
            stateReadyAt: "2026-08-12T10:00:00.000Z",
            postponedUntil: null,
          },
        ] as const
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
                    lanes: [
                      {
                        id: "QUEUE" as const,
                        label: "Queue",
                        count: 0,
                        workItems: [],
                      },
                      {
                        id: "BUILD" as const,
                        label: "Build",
                        count: 0,
                        workItems: [],
                      },
                      {
                        id: "REVIEW" as const,
                        label: "Review",
                        count: 0,
                        workItems: [],
                      },
                      {
                        id: "PR" as const,
                        label: "PR",
                        count: 0,
                        workItems: [],
                      },
                      {
                        id: "ATTENTION" as const,
                        label: "Attention",
                        count: attentionRows.length,
                        workItems: attentionRows,
                      },
                      {
                        id: "MERGED" as const,
                        label: "Merged",
                        count: 0,
                        workItems: [],
                      },
                    ],
                  })
                },
              }),
            ),
          )

          yield* runOperator(["status"], layer)

          expect(logs).toHaveLength(1)
          const document = JSON.parse(logs[0]!) as {
            schemaVersion: number
            command: string
            lanes: readonly {
              id: string
              workItems: readonly {
                id: string
                canRetry: boolean
                state: string
                status: string
                latestStepRunReason: {
                  code: string | null
                  detail: { code?: string } | null
                } | null
              }[]
            }[]
          }
          expect(document.schemaVersion).toBe(CLI_SCHEMA_VERSION)
          expect(document.command).toBe("status")
          const rows =
            document.lanes.find((lane) => lane.id === "ATTENTION")?.workItems ??
            []
          expect(
            rows.map((row) => [
              row.id,
              row.canRetry,
              row.state,
              row.status,
              row.latestStepRunReason?.code,
              row.latestStepRunReason?.detail?.code ?? null,
            ]),
          ).toEqual([
            [
              "wi-retryable-failed",
              true,
              "IMPLEMENT",
              "FAILED",
              "handler_failed",
              "ENOENT",
            ],
            [
              "wi-terminal-failed",
              false,
              "FAILED",
              "FAILED",
              "issue_not_open",
              null,
            ],
            [
              "wi-retryable-needs-human",
              true,
              "NEEDS_HUMAN",
              "NEEDS_HUMAN",
              "review_accepted",
              null,
            ],
            [
              "wi-unavailable-detail",
              true,
              "IMPLEMENT",
              "INTERRUPTED",
              "interrupted",
              null,
            ],
          ])
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

  it("binary help lists start, add, candidates, intake, retry, status, jump, --no-open, and --host", () => {
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
    expect(output).toContain("intake")
    expect(output).toContain("retry")
    expect(output).toContain("status")
    expect(output).toContain("jump")
    expect(output).not.toContain("remove-github-token")
    expect(output).toContain("no-open")
    expect(output).toContain("host")
  })

  it("retry help lists exclusive selectors and is a finite write command", () => {
    const result = spawnSync(
      "bun",
      [
        "--conditions",
        "@ready-for-agent/source",
        "src/main.ts",
        "retry",
        "--help",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    )

    const output = `${result.stdout}\n${result.stderr}`
    expect(result.status).toBe(0)
    expect(output).toContain("retry")
    expect(output).toContain("issue")
    expect(output).toContain("work-item")
    expect(output).toContain("all-retryable")
    expect(output).toContain("max-autonomous-retries")
    expect(output).toContain("versioned JSON")
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

describe("operator binary jump command", () => {
  const sessionId = "85312e9f-9c57-42ef-9757-b2512cee57cd"
  const mockStart = Layer.succeed(StartHarness, {
    start: () => Effect.die("start should not run for jump"),
  })
  const mockLocalGit = Layer.succeed(LocalGit, {
    inspect: () => Effect.die("local git should not run for jump"),
  })

  const jumpGraphql = (
    workItemBySessionId: (
      sessionId: string,
    ) => Effect.Effect<SessionWorkItemLookup, GraphqlRequestFailed>,
  ) =>
    Layer.succeed(GraphqlApi, {
      ...unusedGraphql,
      workItemBySessionId,
    })

  const foundWorkItem = (options: {
    readonly backendId: string
    readonly worktreePath: string | null
    readonly sessionId?: string
  }) => ({
    agentBackend: { id: options.backendId, label: options.backendId },
    sessionId: options.sessionId ?? sessionId,
    worktreePath: options.worktreePath,
  })

  const successfulJumpLayer = (options: {
    readonly workItemBySessionId?: (
      id: string,
    ) => Effect.Effect<SessionWorkItemLookup, GraphqlRequestFailed>
    readonly tmuxModeSelected?: Effect.Effect<boolean>
    readonly createJumpWindow?: (
      input: JumpWindowInput,
    ) => Effect.Effect<void, JumpFailed>
    readonly requireInteractiveTerminal?: Effect.Effect<void, JumpFailed>
    readonly runDirect?: (
      input: DirectLaunchInput,
    ) => Effect.Effect<number, JumpFailed>
    readonly resolve?: (command: string) => Effect.Effect<string, JumpFailed>
  }) =>
    mockStart.pipe(
      Layer.provideMerge(mockLocalGit),
      Layer.provideMerge(
        jumpGraphql(
          options.workItemBySessionId ??
            (() =>
              Effect.succeed(
                foundWorkItem({
                  backendId: "opencode",
                  worktreePath: null,
                }),
              )),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(Tmux, {
          tmuxModeSelected: options.tmuxModeSelected ?? Effect.succeed(true),
          createJumpWindow: options.createJumpWindow ?? (() => Effect.void),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(DirectTerminal, {
          requireInteractiveTerminal:
            options.requireInteractiveTerminal ?? Effect.void,
          run: options.runDirect ?? (() => Effect.succeed(0)),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ExecutablePath, {
          resolve:
            options.resolve ??
            ((command) => Effect.succeed(`/usr/bin/${command}`)),
        }),
      ),
    )

  it.live("jump looks up the Session ID through GraphQL", () =>
    Effect.gen(function* () {
      let requested: string | undefined
      yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          workItemBySessionId: (id) => {
            requested = id
            return Effect.succeed(
              foundWorkItem({ backendId: "opencode", worktreePath: null }),
            )
          },
        }),
      )
      expect(requested).toBe(sessionId)
    }),
  )

  it.live("jump rejects a non-interactive terminal before GraphQL", () =>
    Effect.gen(function* () {
      let lookedUp = false
      let launched = false
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          tmuxModeSelected: Effect.succeed(false),
          requireInteractiveTerminal: Effect.fail(
            new JumpFailed({
              message: "jump requires an interactive terminal",
            }),
          ),
          workItemBySessionId: () => {
            lookedUp = true
            return Effect.die("GraphQL should not run without a TTY")
          },
          runDirect: () => {
            launched = true
            return Effect.die("direct launch should not run without a TTY")
          },
        }),
      ).pipe(Effect.flip)

      expect(lookedUp).toBe(false)
      expect(launched).toBe(false)
      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe("jump requires an interactive terminal")
      }
    }),
  )

  it.live("jump routes to direct continuation when tmux mode is off", () =>
    Effect.gen(function* () {
      let created = false
      let launched: DirectLaunchInput | undefined
      const previousExitCode = process.exitCode
      try {
        yield* runOperator(
          ["jump", sessionId],
          successfulJumpLayer({
            tmuxModeSelected: Effect.succeed(false),
            createJumpWindow: () => {
              created = true
              return Effect.void
            },
            runDirect: (input) =>
              Effect.sync(() => {
                launched = input
                return 0
              }),
          }),
        )
        expect(created).toBe(false)
        expect(launched).toEqual({
          agentExecutable: "/usr/bin/opencode",
          agentArguments: [process.cwd(), "--session", sessionId, "--auto"],
          workingDirectory: process.cwd(),
        })
        expect(process.exitCode ?? 0).toBe(0)
      } finally {
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("jump returns a backend exit status without JumpFailed", () =>
    Effect.gen(function* () {
      const previousExitCode = process.exitCode
      try {
        yield* runOperator(
          ["jump", sessionId],
          successfulJumpLayer({
            tmuxModeSelected: Effect.succeed(false),
            runDirect: () => Effect.succeed(7),
          }),
        )
        expect(process.exitCode).toBe(7)
      } finally {
        process.exitCode = previousExitCode
      }
    }),
  )

  it.live("jump maps a direct spawn failure to JumpFailed", () =>
    Effect.gen(function* () {
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          tmuxModeSelected: Effect.succeed(false),
          runDirect: () =>
            Effect.fail(
              new JumpFailed({
                message:
                  "could not start Agent Backend executable '/usr/bin/opencode'",
              }),
            ),
        }),
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(
          "could not start Agent Backend executable '/usr/bin/opencode'",
        )
      }
    }),
  )

  it.live("jump fails when the Harness is unreachable", () =>
    Effect.gen(function* () {
      const harnessDown = harnessNotRunningMessage()
      let created = false
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          workItemBySessionId: () =>
            Effect.fail(
              new GraphqlRequestFailed({
                code: HARNESS_UNREACHABLE_CODE,
                message: harnessDown,
              }),
            ),
          createJumpWindow: () => {
            created = true
            return Effect.void
          },
        }),
      ).pipe(Effect.flip)

      expect(created).toBe(false)
      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(harnessDown)
        expect(result.message).toContain(HARNESS_START_HINT)
      }
    }),
  )

  it.live("jump fails when no Work Item owns the Session ID", () =>
    Effect.gen(function* () {
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          workItemBySessionId: () =>
            Effect.fail(
              new GraphqlRequestFailed({
                code: "SESSION_NOT_FOUND",
                message: `No Work Item owns Session ID: ${sessionId}`,
              }),
            ),
        }),
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(
          `No Work Item owns Session ID: ${sessionId}`,
        )
      }
    }),
  )

  it.live("jump fails when multiple Work Items own the Session ID", () =>
    Effect.gen(function* () {
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          workItemBySessionId: () =>
            Effect.fail(
              new GraphqlRequestFailed({
                code: "SESSION_AMBIGUOUS",
                message: `Multiple Work Items own Session ID: ${sessionId}`,
              }),
            ),
        }),
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(
          `Multiple Work Items own Session ID: ${sessionId}`,
        )
      }
    }),
  )

  it.live("jump fails when the captured Agent Backend is unsupported", () =>
    Effect.gen(function* () {
      let resolved: string | undefined
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          workItemBySessionId: () =>
            Effect.succeed(
              foundWorkItem({
                backendId: "unknown-backend",
                worktreePath: null,
              }),
            ),
          resolve: (command) => {
            resolved = command
            return Effect.succeed(`/usr/bin/${command}`)
          },
        }),
      ).pipe(Effect.flip)

      expect(resolved).toBeUndefined()
      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(
          "Unsupported Agent Backend: unknown-backend",
        )
      }
    }),
  )

  it.live("jump fails when the backend executable is not on PATH", () =>
    Effect.gen(function* () {
      let created = false
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          resolve: (command) =>
            Effect.fail(
              new JumpFailed({
                message: `Agent Backend executable '${command}' is not on PATH`,
              }),
            ),
          createJumpWindow: () => {
            created = true
            return Effect.void
          },
        }),
      ).pipe(Effect.flip)

      expect(created).toBe(false)
      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(
          "Agent Backend executable 'opencode' is not on PATH",
        )
      }
    }),
  )

  it.live("jump fails when tmux cannot create the window", () =>
    Effect.gen(function* () {
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          createJumpWindow: () =>
            Effect.fail(
              new JumpFailed({
                message: "tmux could not create and arrange the window",
              }),
            ),
        }),
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(
          "tmux could not create and arrange the window",
        )
      }
    }),
  )

  it.live("jump launches the interactive resume command for each backend", () =>
    Effect.gen(function* () {
      const worktree = mkdtempSync(join(tmpdir(), "rfa-jump-wt-"))
      mkdirSync(join(worktree, "src"))
      try {
        const expected = {
          opencode: {
            executable: "/usr/bin/opencode",
            arguments: [worktree, "--session", sessionId, "--auto"],
          },
          grok: {
            executable: "/usr/bin/grok",
            arguments: [
              "--cwd",
              worktree,
              "--resume",
              sessionId,
              "--permission-mode",
              "bypassPermissions",
            ],
          },
          codex: {
            executable: "/usr/bin/codex",
            arguments: [
              "resume",
              "--dangerously-bypass-approvals-and-sandbox",
              "-C",
              worktree,
              sessionId,
            ],
          },
          claude: {
            executable: "/usr/bin/claude",
            arguments: [
              "--resume",
              sessionId,
              "--dangerously-skip-permissions",
            ],
          },
        } as const

        for (const [backendId, want] of Object.entries(expected)) {
          let captured: JumpWindowInput | undefined
          yield* runOperator(
            ["jump", sessionId],
            successfulJumpLayer({
              workItemBySessionId: () =>
                Effect.succeed(
                  foundWorkItem({ backendId, worktreePath: worktree }),
                ),
              createJumpWindow: (input) =>
                Effect.sync(() => {
                  captured = input
                }),
            }),
          )
          expect(captured).toEqual({
            sessionId,
            workingDirectory: worktree,
            agentExecutable: want.executable,
            agentArguments: want.arguments,
            backendId,
          })
        }
      } finally {
        rmSync(worktree, { recursive: true, force: true })
      }
    }),
  )

  it.live("jump uses the CLI cwd when the worktree is missing", () =>
    Effect.gen(function* () {
      let captured: JumpWindowInput | undefined
      yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          workItemBySessionId: () =>
            Effect.succeed(
              foundWorkItem({
                backendId: "opencode",
                worktreePath: "/tmp/rfa-missing-worktree-does-not-exist",
              }),
            ),
          createJumpWindow: (input) =>
            Effect.sync(() => {
              captured = input
            }),
        }),
      )

      expect(captured?.workingDirectory).toBe(process.cwd())
      expect(captured?.agentArguments).toEqual([
        process.cwd(),
        "--session",
        sessionId,
        "--auto",
      ])
    }),
  )

  it.live("jump succeeds silently without mutating Work Item state", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }
      try {
        yield* runOperator(["jump", sessionId], successfulJumpLayer({}))
        expect(logs).toEqual([])
      } finally {
        console.log = originalLog
      }
    }),
  )

  const windowListFormat =
    "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{@rfa-session-id}"
  const paneListFormat = "#{pane_id} #{@rfa-agent}"
  const jumpInput = {
    sessionId,
    workingDirectory: "/tmp/rfa-jump-worktree",
    agentExecutable: "/usr/bin/opencode",
    agentArguments: [
      "/tmp/rfa-jump-worktree",
      "--session",
      sessionId,
      "--auto",
    ],
    backendId: "opencode",
  } as const

  const omittedTmuxEnvPrefixes = [
    "TMUX=",
    "TMUX_PANE=",
    "TERM=",
    "PWD=",
  ] as const

  const tmuxFlagEnvAssignments = (
    args: readonly string[],
  ): readonly string[] => {
    const separator = args.indexOf("--")
    const limit = separator === -1 ? args.length : separator
    const assignments: string[] = []
    for (let i = 0; i < limit; i++) {
      if (args[i] !== "-e") {
        continue
      }
      const assignment = args[i + 1]
      if (assignment !== undefined) {
        assignments.push(assignment)
      }
      i += 1
    }
    return assignments
  }

  const withoutTmuxEnvFlags = (args: readonly string[]): string[] => {
    const out: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e") {
        i += 1
        continue
      }
      const arg = args[i]
      if (arg !== undefined) {
        out.push(arg)
      }
    }
    return out
  }

  const expectForwardedPaneEnvironment = (args: readonly string[]) => {
    const assignments = tmuxFlagEnvAssignments(args)
    expect(assignments).toContain("CLAUDE_CODE_USE_BEDROCK=1")
    for (const prefix of omittedTmuxEnvPrefixes) {
      expect(
        assignments.some((assignment) => assignment.startsWith(prefix)),
      ).toBe(false)
    }
    const separator = args.indexOf("--")
    const firstEnv = args.indexOf("-e")
    expect(firstEnv).toBeGreaterThan(-1)
    expect(separator).toBeGreaterThan(firstEnv)
  }

  const jumpProcessEnvFixture = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    TMUX: "/tmp/tmux-1000/default,1,0",
    TMUX_PANE: "%9",
    TERM: "xterm-256color",
    PWD: "/tmp/wrong-pwd",
  } as const

  const withProcessEnv = (
    overrides: Record<string, string>,
    body: Effect.Effect<void, JumpFailed>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous: Record<string, string | undefined> = {}
        for (const [name, value] of Object.entries(overrides)) {
          previous[name] = process.env[name]
          process.env[name] = value
        }
        return previous
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) {
              delete process.env[name]
            } else {
              process.env[name] = value
            }
          }
        }),
    )

  const recordingTmux = (script: {
    readonly currentSession?: string
    readonly windows?: string
    readonly panes?: string
    readonly failOn?: string
  }) => {
    const invocations: string[][] = []
    const encoder = new TextEncoder()
    const service = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("expected standard command")
        }
        invocations.push([...command.args])
        let stdout = ""
        let exit = 0
        if (
          script.failOn !== undefined &&
          command.args.includes(script.failOn)
        ) {
          exit = 1
        } else if (command.args[0] === "display-message") {
          stdout = `${script.currentSession ?? "$0"}\n`
        } else if (command.args[0] === "list-windows") {
          stdout =
            script.windows === undefined || script.windows.length === 0
              ? ""
              : `${script.windows}\n`
        } else if (command.args[0] === "list-panes") {
          stdout = `${script.panes ?? "%1 1\n%2"}\n`
        } else if (command.args.includes("new-window")) {
          stdout = "@1 %1\n"
        } else if (
          command.args[0] === "split-window" &&
          command.args.includes("-P")
        ) {
          stdout = "%3\n"
        }
        const bytes = encoder.encode(stdout)
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: {
            onStart: () => Effect.void,
            onInput: () => Effect.void,
            onEnd: () => Effect.void,
          } as never,
          stdout: Stream.succeed(bytes),
          stderr: Stream.empty,
          all: Stream.succeed(bytes),
          getInputFd: () =>
            ({
              onStart: () => Effect.void,
              onInput: () => Effect.void,
              onEnd: () => Effect.void,
            }) as never,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    )

    return {
      invocations,
      layer: Tmux.layer.pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
        ),
      ),
    }
  }

  const runCreateJumpWindow = (
    layer: Layer.Layer<Tmux, never, never>,
    input: JumpWindowInput = jumpInput,
  ) =>
    Effect.gen(function* () {
      const tmux = yield* Tmux
      return yield* tmux.createJumpWindow(input)
    }).pipe(Effect.provide(layer))

  it.live(
    "jump selects an existing tagged window in the current tmux session",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({
          windows: `$0\tdefault\t@5\t3\t${sessionId}`,
          panes: "%1 1\n%2",
        })
        yield* runCreateJumpWindow(tmux.layer)
        expect(tmux.invocations).toEqual([
          ["display-message", "-p", "#{session_id}"],
          ["list-windows", "-a", "-F", windowListFormat],
          ["list-panes", "-t", "@5", "-F", paneListFormat],
          ["select-pane", "-t", "%1"],
          ["select-window", "-t", "@5"],
        ])
      }),
  )

  it.live(
    "jump recreates the agent pane when the tagged window only has a shell",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({
          windows: `$0\tdefault\t@5\t3\t${sessionId}`,
          panes: "%2",
        })
        yield* runCreateJumpWindow(tmux.layer)
        expect(tmux.invocations.map(withoutTmuxEnvFlags)).toEqual([
          ["display-message", "-p", "#{session_id}"],
          ["list-windows", "-a", "-F", windowListFormat],
          ["list-panes", "-t", "@5", "-F", paneListFormat],
          [
            "split-window",
            "-h",
            "-b",
            "-P",
            "-F",
            "#{pane_id}",
            "-t",
            "@5",
            "-c",
            jumpInput.workingDirectory,
            "--",
            jumpInput.agentExecutable,
            ...jumpInput.agentArguments,
          ],
          ["set-option", "-p", "-t", "%3", "@rfa-agent", "1"],
          ["select-layout", "-t", "@5", "even-horizontal"],
          ["select-pane", "-t", "%3"],
          ["select-window", "-t", "@5"],
        ])
      }),
  )

  it.live(
    "jump fails and reports the other tmux session when the tagged window is foreign",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({
          windows: `$1\tother\t@8\t2\t${sessionId}`,
        })
        const result = yield* runCreateJumpWindow(tmux.layer).pipe(Effect.flip)
        expect(result).toBeInstanceOf(JumpFailed)
        if (result instanceof JumpFailed) {
          expect(result.message).toBe(
            "Session already open in tmux session 'other' window 2",
          )
        }
        expect(
          tmux.invocations.some((args) => args.includes("new-window")),
        ).toBe(false)
        expect(
          tmux.invocations.some((args) => args.includes("kill-window")),
        ).toBe(false)
      }),
  )

  it.live(
    "jump stores the full Session ID and names the window rfa:<first-8>",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({})
        yield* runCreateJumpWindow(tmux.layer)
        expect(tmux.invocations.map(withoutTmuxEnvFlags)).toEqual([
          ["display-message", "-p", "#{session_id}"],
          ["list-windows", "-a", "-F", windowListFormat],
          [
            "new-window",
            "-d",
            "-P",
            "-F",
            "#{window_id} #{pane_id}",
            "-n",
            "rfa:85312e9f",
            "-c",
            jumpInput.workingDirectory,
            "--",
            jumpInput.agentExecutable,
            ...jumpInput.agentArguments,
          ],
          ["set-option", "-w", "-t", "@1", "@rfa-session-id", sessionId],
          ["set-option", "-p", "-t", "%1", "@rfa-agent", "1"],
          ["split-window", "-h", "-t", "@1", "-c", jumpInput.workingDirectory],
          ["select-layout", "-t", "@1", "even-horizontal"],
          ["select-pane", "-t", "%1"],
          ["select-window", "-t", "@1"],
        ])
      }),
  )

  it.live(
    "jump forwards the operator environment on new-window and omits tmux-owned vars",
    () =>
      withProcessEnv(
        jumpProcessEnvFixture,
        Effect.gen(function* () {
          const tmux = recordingTmux({})
          yield* runCreateJumpWindow(tmux.layer)
          const created = tmux.invocations.find((args) =>
            args.includes("new-window"),
          )
          expect(created).toBeDefined()
          if (created === undefined) {
            return
          }
          expectForwardedPaneEnvironment(created)
        }),
      ),
  )

  it.live(
    "jump forwards the operator environment when recreating the agent pane",
    () =>
      withProcessEnv(
        jumpProcessEnvFixture,
        Effect.gen(function* () {
          const tmux = recordingTmux({
            windows: `$0\tdefault\t@5\t3\t${sessionId}`,
            panes: "%2",
          })
          yield* runCreateJumpWindow(tmux.layer)
          const recreated = tmux.invocations.find(
            (args) => args[0] === "split-window" && args.includes("-P"),
          )
          expect(recreated).toBeDefined()
          if (recreated === undefined) {
            return
          }
          expectForwardedPaneEnvironment(recreated)
        }),
      ),
  )

  it.live("jump sets DISABLE_AUTOUPDATER for the claude backend pane", () =>
    withProcessEnv(
      jumpProcessEnvFixture,
      Effect.gen(function* () {
        const tmux = recordingTmux({})
        yield* runCreateJumpWindow(tmux.layer, {
          ...jumpInput,
          backendId: "claude",
          agentExecutable: "/usr/bin/claude",
          agentArguments: [
            "--resume",
            sessionId,
            "--dangerously-skip-permissions",
          ],
        })
        const created = tmux.invocations.find((args) =>
          args.includes("new-window"),
        )
        expect(created).toBeDefined()
        if (created === undefined) {
          return
        }
        expect(tmuxFlagEnvAssignments(created)).toContain(
          "DISABLE_AUTOUPDATER=1",
        )
      }),
    ),
  )

  it.live(
    "jump kills only the window it created when later tmux setup fails",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({ failOn: "split-window" })
        const result = yield* runCreateJumpWindow(tmux.layer).pipe(Effect.flip)
        expect(result).toBeInstanceOf(JumpFailed)
        if (result instanceof JumpFailed) {
          expect(result.message).toContain(
            "tmux could not create and arrange the window",
          )
        }
        expect(tmux.invocations.at(-1)).toEqual(["kill-window", "-t", "@1"])
        expect(
          tmux.invocations.filter((args) => args.includes("kill-window")),
        ).toHaveLength(1)
      }),
  )

  it.live(
    "jump reuses a sole remaining pane when it is still the tagged agent",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({
          windows: `$0\tdefault\t@5\t3\t${sessionId}`,
          panes: "%1 1",
        })
        yield* runCreateJumpWindow(tmux.layer)
        expect(tmux.invocations).toEqual([
          ["display-message", "-p", "#{session_id}"],
          ["list-windows", "-a", "-F", windowListFormat],
          ["list-panes", "-t", "@5", "-F", paneListFormat],
          ["select-pane", "-t", "%1"],
          ["select-window", "-t", "@5"],
        ])
        expect(
          tmux.invocations.some((args) => args.includes("split-window")),
        ).toBe(false)
      }),
  )

  it.live(
    "jump does not kill a newly created window when only the client switch fails",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({ failOn: "select-window" })
        const result = yield* runCreateJumpWindow(tmux.layer).pipe(Effect.flip)
        expect(result).toBeInstanceOf(JumpFailed)
        expect(
          tmux.invocations.some((args) => args.includes("kill-window")),
        ).toBe(false)
        expect(tmux.invocations).toContainEqual([
          "set-option",
          "-p",
          "-t",
          "%1",
          "@rfa-agent",
          "1",
        ])
      }),
  )

  it.live(
    "jump does not kill a pre-existing tagged window when recreation fails",
    () =>
      Effect.gen(function* () {
        const tmux = recordingTmux({
          windows: `$0\tdefault\t@5\t3\t${sessionId}`,
          panes: "%2",
          failOn: "split-window",
        })
        const result = yield* runCreateJumpWindow(tmux.layer).pipe(Effect.flip)
        expect(result).toBeInstanceOf(JumpFailed)
        expect(
          tmux.invocations.some((args) => args.includes("kill-window")),
        ).toBe(false)
      }),
  )
})
