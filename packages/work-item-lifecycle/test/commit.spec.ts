import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import {
  Opencode,
  OpencodeExitError,
  OpencodeTimeoutError,
  SessionIdNotFoundError,
} from "@ready-for-agent/opencode"
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
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath,
  sessionId: "ses_implement_session",
  ...overrides,
})

const stubOpencode = (impl: {
  readonly start?: (input: {
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string }, never>
  readonly continue?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string }, never>
}) =>
  Layer.succeed(
    Opencode,
    Opencode.of({
      start: (input) =>
        impl.start?.(input) ??
        Effect.succeed({
          sessionId: "ses_start_should_not_run",
          assistantText: "",
        }),
      continue: (input) =>
        impl.continue?.(input) ??
        Effect.succeed({ sessionId: "ses_commit_default", assistantText: "" }),
      listModels: () => Effect.succeed([]),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, Opencode>,
  opencodeLayer: Layer.Layer<Opencode, never, never> = stubOpencode({}),
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
            variant: "max",
            reviewModel: "opencode/commit-model",
            reviewVariant: "max",
            maxDuration: Duration.minutes(10),
          }),
        ),
        stubOpencode({
          start: () => {
            started = true
            return Effect.succeed({ sessionId: "ses_wrong", assistantText: "" })
          },
          continue: (input) => {
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
      expect(continued!.variant).toBe("max")
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
          Opencode,
          Opencode.of({
            start: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continue: () =>
              Effect.fail(new OpencodeExitError({ exitCode: 2, cwd: root })),
            listModels: () => Effect.succeed([]),
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
          Opencode,
          Opencode.of({
            start: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continue: () =>
              Effect.fail(
                new OpencodeTimeoutError({ cwd: root, timeoutMs: 1_000 }),
              ),
            listModels: () => Effect.succeed([]),
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
          Opencode,
          Opencode.of({
            start: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continue: () =>
              Effect.fail(new SessionIdNotFoundError({ cwd: root })),
            listModels: () => Effect.succeed([]),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
    }))
})
