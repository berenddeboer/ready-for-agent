import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Fiber, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql"
import {
  type ActiveAgentBackend,
  AgentBackend,
  AgentBackendExitError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
  type StartInput,
  runCliTurn,
  sanitizeInheritedEnvironment,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { extractCauseChain } from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import type { LifecycleStepContext } from "../src/index.js"
import {
  ImplementInvalidWorktreeContextError,
  ImplementIssueContextMissingError,
  ImplementOpenCodeError,
  ImplementRepositoryNotFoundError,
  ImplementWorktreeContextMissingError,
  implement,
  makeWorkItemId,
  stubActiveAgentBackendLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-missing",
  issueNumber: 80,
  issueTitle: null,
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,

  publicationTitle: null,

  publicationBody: null,
  sessionId: null,
  ...overrides,
})

const stubOpencode = (impl: {
  readonly startTurn?: (
    input: StartInput,
  ) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  readonly continueTurn?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
}) =>
  Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: (input) =>
        impl.startTurn?.(input) ??
        Effect.succeed({
          sessionId: "ses_implement_default",
          assistantText: "",
        }),
      continueTurn: (input) =>
        impl.continueTurn?.(input) ??
        Effect.succeed({
          sessionId: "ses_continue_should_not_run",
          assistantText: "",
        }),
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )

const keymaxxerDisabled = Layer.mergeAll(
  Layer.succeed(KeymaxxerService, {
    enabled: false,
    initialize: Effect.void,
    hasSecret: () => Effect.succeed(false),
    findSecret: () => Effect.die("must not inspect the vault"),
    findSecrets: () => Effect.succeed([]),
    addSecret: () => Effect.succeed(false),
    runWithSecrets: () =>
      Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  } satisfies KeymaxxerServiceShape),
  stubActiveAgentBackendLayer(),
)

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Layer.Layer.Success<typeof PlatformLayer>
    | Layer.Layer.Success<typeof DbServiceLive>
    | Layer.Layer.Success<typeof DatabaseTest>
    | AgentBackend
    | ActiveAgentBackend
    | KeymaxxerService
  >,
  opencodeLayer: Layer.Layer<AgentBackend, never, never> = stubOpencode({}),
  forgeAuthLayer: Layer.Layer<
    ActiveAgentBackend | KeymaxxerService,
    never,
    never
  > = keymaxxerDisabled,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(opencodeLayer),
      Effect.provide(forgeAuthLayer),
      Effect.provide(DbServiceLive),
      Effect.provide(DatabaseTest),
      Effect.provide(PlatformLayer),
    ),
  )

const seedWorkItem = (workItemId: string, repositoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = Date.now()
    yield* sql.unsafe(
      `INSERT INTO work_item (
         id, repository_id, issue_number, state, state_ready_at, worktree_path,
         session_id, failure_code, failure_message, created_at, updated_at
       ) VALUES (?, ?, 80,
         'implement', ?, NULL, NULL, NULL, NULL, ?, ?)`,
      [workItemId, repositoryId, now, now, now],
    )
  })

const readSessionId = (workItemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = (yield* sql.unsafe(
      `SELECT session_id FROM work_item WHERE id = ? LIMIT 1`,
      [workItemId],
    )) as readonly { readonly session_id: string | null }[]
    return rows[0]?.session_id ?? null
  })

const withTemp = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-implement-"))
  try {
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const expectedAttachmentDirectory = (workItemId: string): string =>
  `${tmpdir().replace(/[/\\]+$/, "")}/ready-for-agent/pr-attachments/${workItemId}`

const expectVisualEvidencePrompt = (prompt: string, workItemId: string) => {
  expect(prompt).toContain(expectedAttachmentDirectory(workItemId))
  expect(prompt).toContain("genuine before-shot")
  expect(prompt).toContain("before any")
  expect(prompt).toContain("after/production")
  expect(prompt).toMatch(/[Dd]o not open or edit a pull request/)
}

const seedRepository = (
  localPath: string,
  identity: {
    readonly forge: "github" | "gitlab" | "azure-devops"
    readonly forgeHost: string
    readonly projectPath: string
  } = {
    forge: "github",
    forgeHost: "github.com",
    projectPath: "acme/widgets",
  },
) =>
  Effect.gen(function* () {
    const db = yield* DbService
    return yield* db.addRepository({
      ...identity,
      localPath,
      isBare: true,
    })
  })

describe("implement", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(implement(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ImplementWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-implement-missing-worktree")
    const error = await run(implement(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ImplementInvalidWorktreeContextError)
  })

  it("rejects missing Repository context", () =>
    withTemp(async (root) => {
      const error = await run(implement(baseContext(root)).pipe(Effect.flip))
      expect(error).toBeInstanceOf(ImplementRepositoryNotFoundError)
    }))

  it("rejects missing Issue identity", () =>
    withTemp(async (root) => {
      const error = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              repositoryId: repository.id,
              issueNumber: 0,
            }),
          )
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(ImplementIssueContextMissingError)
    }))

  it("starts OpenCode with exact issue identity, worktree, model, and variant when no prior session", () =>
    withTemp(async (root) => {
      const workItemId = makeWorkItemId()
      let started: {
        prompt: string
        cwd: string
        model: string
        variant: string
        timeout?: Duration.Input
      } | null = null
      let continued = false

      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              workItemId,
              repositoryId: repository.id,
              issueNumber: 80,
              issueTitle: null,
              agentBackend: "opencode",
              model: "opencode/implement-model",
              thinkingLevel: "max",
              reviewModel: "opencode/implement-model",
              reviewThinkingLevel: "max",
              sessionId: null,
              maxDuration: Duration.minutes(90),
            }),
          )
        }),
        stubOpencode({
          startTurn: (input) => {
            started = input
            return Effect.succeed({
              sessionId: "ses_fresh_implement",
              assistantText: "",
            })
          },
          continueTurn: () => {
            continued = true
            return Effect.succeed({ sessionId: "ses_wrong", assistantText: "" })
          },
        }),
      )

      expect(sessionId).toBe("ses_fresh_implement")
      expect(started).not.toBeNull()
      expect(started!.cwd).toBe(root)
      expect(started!.model).toBe("opencode/implement-model")
      expect(started!.thinkingLevel).toBe("max")
      expect(Duration.toMillis(started!.timeout!)).toBe(
        Duration.toMillis(Duration.minutes(90)),
      )
      expect(started!.prompt).toContain("acme/widgets#80")
      expect(started!.prompt).toContain("Inspect the current GitHub Issue")
      expect(started!.prompt).toContain("run appropriate verification")
      expect(started!.prompt).toContain("Do not merely propose a plan")
      expectVisualEvidencePrompt(started!.prompt, workItemId)
      expect(continued).toBe(false)
    }))

  it("does not write attachment files into the target worktree", () =>
    withTemp(async (root) => {
      const before = await readdir(root)
      await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, { repositoryId: repository.id }),
          )
        }),
      )
      expect(await readdir(root)).toEqual(before)
    }))

  it("starts a GitLab Implement turn with glab credential guidance and no curl or gh guidance", () =>
    withTemp(async (root) => {
      const workItemId = makeWorkItemId()
      let prompt = ""
      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root, {
            forge: "gitlab",
            forgeHost: "git.drupalcode.org",
            projectPath: "project/oauth_client",
          })
          return yield* implement(
            baseContext(root, {
              workItemId,
              repositoryId: repository.id,
              issueNumber: 3601642,
            }),
          )
        }),
        stubOpencode({
          startTurn: (input) => {
            prompt = input.prompt
            return Effect.succeed({
              sessionId: "ses_gitlab_implement",
              assistantText: "",
            })
          },
        }),
      )

      expect(sessionId).toBe("ses_gitlab_implement")
      expect(prompt).toContain(
        "GitLab issue project/oauth_client#3601642 on git.drupalcode.org",
      )
      expect(prompt).toContain("Inspect the current GitLab Issue")
      expect(prompt).toContain("glab")
      expect(prompt).toContain(
        "https://git.drupalcode.org/project/oauth_client",
      )
      expect(prompt).not.toContain("curl")
      expect(prompt).not.toMatch(/\bgh\b/i)
      expect(prompt).not.toContain("GitHub")
      expectVisualEvidencePrompt(prompt, workItemId)
    }))

  it("uses the Repository-scoped Keymaxxer credential for a GitLab Implement turn", () =>
    withTemp(async (root) => {
      let prompt = ""
      const findSecretCalls: {
        readonly provider: string
        readonly account: string
      }[] = []
      const vaultAuth = Layer.mergeAll(
        Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          hasSecret: () => Effect.succeed(true),
          findSecret: (input) => {
            findSecretCalls.push(input)
            return Effect.succeed("GITLAB_TOKEN_PROJECT_OAUTH_CLIENT")
          },
          findSecrets: () => Effect.succeed([]),
          addSecret: () => Effect.succeed(true),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        } satisfies KeymaxxerServiceShape),
        stubActiveAgentBackendLayer(),
      )
      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root, {
            forge: "gitlab",
            forgeHost: "git.drupalcode.org",
            projectPath: "project/oauth_client",
          })
          return yield* implement(
            baseContext(root, {
              repositoryId: repository.id,
              issueNumber: 3601642,
            }),
          )
        }),
        stubOpencode({
          startTurn: (input) => {
            prompt = input.prompt
            return Effect.succeed({
              sessionId: "ses_gitlab_vault_implement",
              assistantText: "",
            })
          },
        }),
        vaultAuth,
      )

      expect(sessionId).toBe("ses_gitlab_vault_implement")
      expect(findSecretCalls).toEqual([
        {
          provider: "gitlab",
          account: "git.drupalcode.org/project/oauth_client",
        },
      ])
      expect(prompt).toContain(
        "use Keymaxxer secret GITLAB_TOKEN_PROJECT_OAUTH_CLIENT via keymaxxer_run",
      )
      expect(prompt).toContain("glab")
      expect(prompt).toContain(
        'GITLAB_TOKEN="$GITLAB_TOKEN_PROJECT_OAUTH_CLIENT"',
      )
      expect(prompt).toContain('GITLAB_HOST="https://git.drupalcode.org"')
      expect(prompt).toContain(
        'set "GITLAB_TOKEN=%GITLAB_TOKEN_PROJECT_OAUTH_CLIENT%"',
      )
      expect(prompt).toContain('set "GITLAB_HOST=https://git.drupalcode.org"')
      expect(prompt).not.toContain("curl")
      expect(prompt).not.toContain("PRIVATE-TOKEN")
      expect(prompt).not.toContain("ambient GITLAB_TOKEN")
      expect(prompt).not.toMatch(/\bgh\b/i)
    }))

  it("starts an Azure DevOps Implement turn with REST API ambient guidance and no glab or gh guidance", () =>
    withTemp(async (root) => {
      const workItemId = makeWorkItemId()
      let prompt = ""
      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root, {
            forge: "azure-devops",
            forgeHost: "dev.azure.com",
            projectPath: "acme/widgets",
          })
          return yield* implement(
            baseContext(root, {
              workItemId,
              repositoryId: repository.id,
              issueNumber: 4021,
            }),
          )
        }),
        stubOpencode({
          startTurn: (input) => {
            prompt = input.prompt
            return Effect.succeed({
              sessionId: "ses_azure_devops_implement",
              assistantText: "",
            })
          },
        }),
      )

      expect(sessionId).toBe("ses_azure_devops_implement")
      expect(prompt).toContain(
        "Implement Azure DevOps issue acme/widgets#4021 on dev.azure.com.",
      )
      expect(prompt).toContain("Inspect the current Azure DevOps Issue")
      expect(prompt).toContain("AZURE_DEVOPS_EXT_PAT")
      expect(prompt).toContain("https://dev.azure.com/acme/widgets")
      expect(prompt).toContain("Azure DevOps Work Item or REST API access")
      expect(prompt).not.toContain("glab")
      expect(prompt).not.toMatch(/\bgh\b/i)
      expect(prompt).not.toContain("GitLab")
      expectVisualEvidencePrompt(prompt, workItemId)
    }))

  it("uses the Repository-scoped Keymaxxer credential for an Azure DevOps Implement turn", () =>
    withTemp(async (root) => {
      let prompt = ""
      const findSecretCalls: {
        readonly provider: string
        readonly account: string
      }[] = []
      const vaultAuth = Layer.mergeAll(
        Layer.succeed(KeymaxxerService, {
          initialize: Effect.void,
          hasSecret: () => Effect.succeed(true),
          findSecret: (input) => {
            findSecretCalls.push(input)
            return Effect.succeed("AZURE_DEVOPS_PAT_ACME_WIDGETS")
          },
          findSecrets: () => Effect.succeed([]),
          addSecret: () => Effect.succeed(true),
          runWithSecrets: () =>
            Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        } satisfies KeymaxxerServiceShape),
        stubActiveAgentBackendLayer(),
      )
      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root, {
            forge: "azure-devops",
            forgeHost: "dev.azure.com",
            projectPath: "acme/widgets",
          })
          return yield* implement(
            baseContext(root, {
              repositoryId: repository.id,
              issueNumber: 4021,
            }),
          )
        }),
        stubOpencode({
          startTurn: (input) => {
            prompt = input.prompt
            return Effect.succeed({
              sessionId: "ses_azure_devops_vault_implement",
              assistantText: "",
            })
          },
        }),
        vaultAuth,
      )

      expect(sessionId).toBe("ses_azure_devops_vault_implement")
      expect(findSecretCalls).toEqual([
        { provider: "azure-devops", account: "acme/widgets" },
      ])
      expect(prompt).toContain(
        "use Keymaxxer secret AZURE_DEVOPS_PAT_ACME_WIDGETS via keymaxxer_run",
      )
      expect(prompt).toContain('"$AZURE_DEVOPS_PAT_ACME_WIDGETS"')
      expect(prompt).not.toContain("glab")
      expect(prompt).not.toContain("GITLAB_TOKEN")
    }))

  it("starts a fresh Session when session_id is blank", () =>
    withTemp(async (root) => {
      let started = false
      let continued = false

      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              repositoryId: repository.id,
              sessionId: "   ",
            }),
          )
        }),
        stubOpencode({
          startTurn: () => {
            started = true
            return Effect.succeed({
              sessionId: "ses_blank_prior_start",
              assistantText: "",
            })
          },
          continueTurn: () => {
            continued = true
            return Effect.succeed({
              sessionId: "ses_should_not",
              assistantText: "",
            })
          },
        }),
      )

      expect(sessionId).toBe("ses_blank_prior_start")
      expect(started).toBe(true)
      expect(continued).toBe(false)
    }))

  it("continues the prior OpenCode Session when session_id is set (retry after interrupt)", () =>
    withTemp(async (root) => {
      const workItemId = makeWorkItemId()
      let continued: {
        sessionId: string
        prompt: string
        cwd: string
        model: string
        variant: string
        timeout?: Duration.Input
      } | null = null
      let started = false

      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              workItemId,
              repositoryId: repository.id,
              issueNumber: 80,
              issueTitle: null,
              agentBackend: "opencode",
              model: "opencode/implement-model",
              thinkingLevel: "max",
              sessionId: "ses_interrupted_build",
              maxDuration: Duration.minutes(90),
            }),
          )
        }),
        stubOpencode({
          startTurn: () => {
            started = true
            return Effect.succeed({
              sessionId: "ses_should_not_start",
              assistantText: "",
            })
          },
          continueTurn: (input) => {
            continued = input
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "",
            })
          },
        }),
      )

      expect(sessionId).toBe("ses_interrupted_build")
      expect(started).toBe(false)
      expect(continued).not.toBeNull()
      expect(continued!.sessionId).toBe("ses_interrupted_build")
      expect(continued!.cwd).toBe(root)
      expect(continued!.model).toBe("opencode/implement-model")
      expect(continued!.thinkingLevel).toBe("max")
      expect(Duration.toMillis(continued!.timeout!)).toBe(
        Duration.toMillis(Duration.minutes(90)),
      )
      expect(continued!.prompt).toContain("Continue implementing")
      expect(continued!.prompt).toContain("acme/widgets#80")
      expect(continued!.prompt).toContain("interrupted or failed")
      expect(continued!.prompt).toContain("partial work")
      expectVisualEvidencePrompt(continued!.prompt, workItemId)
    }))

  it("continues after a failed Build when session_id exists", () =>
    withTemp(async (root) => {
      const calls: string[] = []

      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              repositoryId: repository.id,
              sessionId: "ses_after_failed_build",
            }),
          )
        }),
        stubOpencode({
          startTurn: () => {
            calls.push("start")
            return Effect.succeed({
              sessionId: "ses_wrong",
              assistantText: "",
            })
          },
          continueTurn: (input) => {
            calls.push(`continue:${input.sessionId}`)
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "",
            })
          },
        }),
      )

      expect(sessionId).toBe("ses_after_failed_build")
      expect(calls).toEqual(["continue:ses_after_failed_build"])
    }))

  it("maps OpenCode exit failure", () =>
    withTemp(async (root) => {
      const error = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, { repositoryId: repository.id }),
          )
        }).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.fail(
                AgentBackendExitError.new({
                  exitCode: 2,
                  cwd: root,
                  message: "OpenCode failed with exit code 2",
                }),
              ),
            continueTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(ImplementOpenCodeError)
      expect((error as ImplementOpenCodeError).worktreePath).toBe(root)
    }))

  it("surfaces a stderr-only Agent Turn failure in the cause chain", () =>
    withTemp(async (root) => {
      const binary = join(root, "fake-cli")
      await writeFile(
        binary,
        "#!/bin/sh\nprintf 'Error: Token has expired and refresh failed\\n' >&2\nexit 1\n",
      )
      await chmod(binary, 0o700)

      const error = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, { repositoryId: repository.id }),
          )
        }).pipe(Effect.flip),
        Layer.effect(
          AgentBackend,
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            return AgentBackend.of({
              startTurn: (input) =>
                runCliTurn({
                  spawner,
                  backend: { id: "opencode", label: "OpenCode" },
                  binary,
                  args: [],
                  cwd: input.cwd,
                  env: sanitizeInheritedEnvironment(),
                  timeout: Duration.seconds(5),
                  parseLine: () => ({}),
                }),
              continueTurn: () =>
                Effect.succeed({ sessionId: "unused", assistantText: "" }),
              inspect: () =>
                Effect.succeed({
                  backend: { id: "opencode" as const, label: "OpenCode" },
                  models: [],
                }),
            })
          }),
        ).pipe(Layer.provide(PlatformLayer)),
      )

      expect(error).toBeInstanceOf(ImplementOpenCodeError)
      expect(extractCauseChain(error)).toEqual([
        {
          name: "ImplementOpenCodeError",
          message: "OpenCode failed to implement the Work Item issue",
        },
        {
          name: "AgentBackendExitError",
          code: "1",
          message: "Error: Token has expired and refresh failed",
        },
      ])
    }))

  it("maps OpenCode timeout failure", () =>
    withTemp(async (root) => {
      const error = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, { repositoryId: repository.id }),
          )
        }).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.fail(
                new AgentBackendTimeoutError({ cwd: root, timeoutMs: 1_000 }),
              ),
            continueTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(ImplementOpenCodeError)
    }))

  it("maps missing Session ID from OpenCode", () =>
    withTemp(async (root) => {
      const error = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, { repositoryId: repository.id }),
          )
        }).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.fail(new AgentBackendSessionIdMissingError({ cwd: root })),
            continueTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(ImplementOpenCodeError)
    }))

  it("rejects an empty Session ID success payload", () =>
    withTemp(async (root) => {
      const error = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, { repositoryId: repository.id }),
          )
        }).pipe(Effect.flip),
        stubOpencode({
          startTurn: () =>
            Effect.succeed({ sessionId: "   ", assistantText: "" }),
        }),
      )
      expect(error).toBeInstanceOf(ImplementOpenCodeError)
      expect((error as ImplementOpenCodeError).message).toContain("Session ID")
    }))

  it("persists session_id mid-run before OpenCode completes", () =>
    withTemp(async (root) => {
      const workItemId = makeWorkItemId()
      const midRunSessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          yield* seedWorkItem(workItemId, repository.id)

          const fiber = yield* Effect.forkChild(
            implement(
              baseContext(root, {
                workItemId,
                repositoryId: repository.id,
              }),
            ),
          )

          let midSessionId: string | null = null
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const sessionId = yield* readSessionId(workItemId)
            if (sessionId !== null && sessionId !== "") {
              midSessionId = sessionId
              break
            }
            yield* Effect.sleep("20 millis")
          }

          const finalSessionId = yield* Fiber.join(fiber)
          return { midSessionId, finalSessionId }
        }),
        stubOpencode({
          startTurn: (input) =>
            Effect.gen(function* () {
              expect(input.onSessionId).toBeDefined()
              yield* input.onSessionId!("ses_mid_build")
              yield* Effect.sleep("150 millis")
              return {
                sessionId: "ses_mid_build",
                assistantText: "",
              }
            }),
        }),
      )

      expect(midRunSessionId.midSessionId).toBe("ses_mid_build")
      expect(midRunSessionId.finalSessionId).toBe("ses_mid_build")
    }))

  it("keeps a mid-run session_id when OpenCode later fails", () =>
    withTemp(async (root) => {
      const workItemId = makeWorkItemId()
      const outcome = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          yield* seedWorkItem(workItemId, repository.id)
          const error = yield* implement(
            baseContext(root, {
              workItemId,
              repositoryId: repository.id,
            }),
          ).pipe(Effect.flip)
          const sessionId = yield* readSessionId(workItemId)
          return { error, sessionId }
        }),
        stubOpencode({
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* input.onSessionId!("ses_failed_after_emit")
              return yield* Effect.fail(
                AgentBackendExitError.new({
                  exitCode: 2,
                  cwd: root,
                  message: "OpenCode failed with exit code 2",
                }),
              )
            }),
        }),
      )

      expect(outcome.error).toBeInstanceOf(ImplementOpenCodeError)
      expect(outcome.sessionId).toBe("ses_failed_after_emit")
    }))

  it("does not fail implement when mid-run session persist has no matching row", () =>
    withTemp(async (root) => {
      const workItemId = makeWorkItemId()
      const sessionId = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              workItemId,
              repositoryId: repository.id,
            }),
          )
        }),
        stubOpencode({
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* input.onSessionId!("ses_no_row")
              return {
                sessionId: "ses_no_row",
                assistantText: "",
              }
            }),
        }),
      )

      expect(sessionId).toBe("ses_no_row")
    }))
})
