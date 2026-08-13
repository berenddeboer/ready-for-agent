import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  buildIntakeSuccessDocument,
  buildStatusSuccessDocument,
  encodeCompactJson,
} from "./cli-json.ts"
import {
  HARNESS_START_HINT,
  HARNESS_UNREACHABLE_CODE,
  harnessNotRunningMessage,
} from "./graphql-error.ts"
import { JumpFailed } from "./jump-error.ts"
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
  kanbanStatus: () => Effect.die("kanbanStatus should not run"),
  workItemBySessionId: () => Effect.die("workItemBySessionId should not run"),
} as const

const unusedJumpServices = Layer.mergeAll(
  Layer.succeed(Tmux, {
    requireAttachedSession: Effect.die("tmux should not run"),
    createJumpWindow: () => Effect.die("tmux should not run"),
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

  it("binary help lists start, add, candidates, intake, status, jump, --no-open, and --host", () => {
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
    expect(output).toContain("status")
    expect(output).toContain("jump")
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
    readonly requireAttachedSession?: Effect.Effect<void, JumpFailed>
    readonly createJumpWindow?: (
      input: JumpWindowInput,
    ) => Effect.Effect<void, JumpFailed>
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
          requireAttachedSession: options.requireAttachedSession ?? Effect.void,
          createJumpWindow: options.createJumpWindow ?? (() => Effect.void),
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

  it.live("jump fails when invoked outside tmux", () =>
    Effect.gen(function* () {
      let lookedUp = false
      const result = yield* runOperator(
        ["jump", sessionId],
        successfulJumpLayer({
          requireAttachedSession: Effect.fail(
            new JumpFailed({
              message: "jump must be run from inside a tmux session",
            }),
          ),
          workItemBySessionId: () => {
            lookedUp = true
            return Effect.die("GraphQL should not run outside tmux")
          },
        }),
      ).pipe(Effect.flip)

      expect(lookedUp).toBe(false)
      expect(result).toBeInstanceOf(JumpFailed)
      if (result instanceof JumpFailed) {
        expect(result.message).toBe(
          "jump must be run from inside a tmux session",
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
            arguments: [worktree, "--session", sessionId],
          },
          grok: {
            executable: "/usr/bin/grok",
            arguments: ["--cwd", worktree, "--resume", sessionId],
          },
          codex: {
            executable: "/usr/bin/codex",
            arguments: ["resume", "-C", worktree, sessionId],
          },
          claude: {
            executable: "/usr/bin/claude",
            arguments: ["--resume", sessionId],
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
            workingDirectory: worktree,
            agentExecutable: want.executable,
            agentArguments: want.arguments,
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
})
