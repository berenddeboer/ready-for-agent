import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentBackend,
  AgentBackendExitError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
  type StartInput,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import type { LifecycleStepContext } from "../src/index.js"
import {
  ImplementInvalidWorktreeContextError,
  ImplementIssueContextMissingError,
  ImplementOpenCodeError,
  ImplementRepositoryNotFoundError,
  ImplementWorktreeContextMissingError,
  implement,
  makeWorkItemId,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-missing",
  githubIssueNumber: 80,
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,
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

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Layer.Layer.Success<typeof PlatformLayer>
    | Layer.Layer.Success<typeof DbServiceLive>
    | Layer.Layer.Success<typeof DatabaseTest>
    | AgentBackend
  >,
  opencodeLayer: Layer.Layer<AgentBackend, never, never> = stubOpencode({}),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(opencodeLayer),
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
         id, repository_id, github_issue_number, state, state_ready_at, worktree_path,
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

const seedRepository = (localPath: string) =>
  Effect.gen(function* () {
    const db = yield* DbService
    return yield* db.addRepository({
      githubOwner: "acme",
      githubRepo: "widgets",
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
              githubIssueNumber: 0,
            }),
          )
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(ImplementIssueContextMissingError)
    }))

  it("starts OpenCode with exact issue identity, worktree, model, and variant when no prior session", () =>
    withTemp(async (root) => {
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
              repositoryId: repository.id,
              githubIssueNumber: 80,
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
      expect(continued).toBe(false)
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
              repositoryId: repository.id,
              githubIssueNumber: 80,
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
                new AgentBackendExitError({ exitCode: 2, cwd: root }),
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
                new AgentBackendExitError({ exitCode: 2, cwd: root }),
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
