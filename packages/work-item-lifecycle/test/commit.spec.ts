import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendExitError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
} from "@ready-for-agent/agent-backend"
import type { LifecycleStepContext } from "../src/index.js"
import {
  CommitInvalidWorktreeContextError,
  CommitOpenCodeError,
  CommitSessionContextMissingError,
  CommitWorktreeContextMissingError,
  commit,
  makeWorkItemId,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 91,
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,
  sessionId: "ses_implement_session",
  ...overrides,
})

const stubOpencode = (impl: {
  readonly startTurn?: (input: {
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string }, never>
  readonly continueTurn?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string }, never>
}) =>
  Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: (input) =>
        impl.startTurn?.(input) ??
        Effect.succeed({
          sessionId: "ses_start_should_not_run",
          assistantText: "",
        }),
      continueTurn: (input) =>
        impl.continueTurn?.(input) ??
        Effect.succeed({ sessionId: "ses_commit_default", assistantText: "" }),
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, AgentBackend>,
  opencodeLayer: Layer.Layer<AgentBackend, never, never> = stubOpencode({}),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(opencodeLayer), Effect.provide(PlatformLayer)),
  )

const withTemp = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-commit-"))
  try {
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("commit", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(commit(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommitWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-commit-missing-worktree")
    const error = await run(commit(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommitInvalidWorktreeContextError)
  })

  it("rejects missing Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        commit(baseContext(root, { sessionId: null })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CommitSessionContextMissingError)
    }))

  it("rejects blank Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        commit(baseContext(root, { sessionId: "   ", assistantText: "" })).pipe(
          Effect.flip,
        ),
      )
      expect(error).toBeInstanceOf(CommitSessionContextMissingError)
    }))

  it("continues the Implement Session with a commit prompt that closes the Issue", () =>
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

      await run(
        commit(
          baseContext(root, {
            sessionId: "ses_from_implement",
            githubIssueNumber: 2039,
            model: "opencode/commit-model",
            thinkingLevel: "max",
            reviewModel: "opencode/commit-model",
            reviewThinkingLevel: "max",
            maxDuration: Duration.minutes(10),
          }),
        ),
        stubOpencode({
          startTurn: () => {
            started = true
            return Effect.succeed({ sessionId: "ses_wrong", assistantText: "" })
          },
          continueTurn: (input) => {
            continued = input
            return Effect.succeed({
              sessionId: "ses_from_implement",
              assistantText: "",
            })
          },
        }),
      )

      expect(started).toBe(false)
      expect(continued).not.toBeNull()
      expect(continued!.sessionId).toBe("ses_from_implement")
      expect(continued!.cwd).toBe(root)
      expect(continued!.model).toBe("opencode/commit-model")
      expect(continued!.thinkingLevel).toBe("max")
      expect(Duration.toMillis(continued!.timeout!)).toBe(
        Duration.toMillis(Duration.minutes(10)),
      )
      expect(continued!.prompt).toContain("Create a git commit")
      expect(continued!.prompt).toContain("closes GitHub issue #2039")
      expect(continued!.prompt).toContain("Do not open a pull request")
    }))

  it("maps OpenCode exit failure", () =>
    withTemp(async (root) => {
      const error = await run(
        commit(baseContext(root)).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(
                new AgentBackendExitError({ exitCode: 2, cwd: root }),
              ),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
      expect((error as CommitOpenCodeError).worktreePath).toBe(root)
      expect((error as CommitOpenCodeError).sessionId).toBe(
        "ses_implement_session",
      )
    }))

  it("maps OpenCode timeout failure", () =>
    withTemp(async (root) => {
      const error = await run(
        commit(baseContext(root)).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(
                new AgentBackendTimeoutError({ cwd: root, timeoutMs: 1_000 }),
              ),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
    }))

  it("maps missing Session ID from OpenCode", () =>
    withTemp(async (root) => {
      const error = await run(
        commit(baseContext(root)).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(new AgentBackendSessionIdMissingError({ cwd: root })),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
    }))
})
