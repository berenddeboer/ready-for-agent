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
  ReviewInvalidWorktreeContextError,
  ReviewOpenCodeError,
  ReviewSessionContextMissingError,
  ReviewWorktreeContextMissingError,
  makeWorkItemId,
  review,
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
  startingCommitOid: null,
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
        Effect.succeed({ sessionId: "ses_review_default", assistantText: "" }),
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
  const root = await mkdtemp(join(tmpdir(), "rfa-review-"))
  try {
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("review", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(review(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ReviewWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-review-missing-worktree")
    const error = await run(review(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ReviewInvalidWorktreeContextError)
  })

  it("rejects missing Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root, { sessionId: null })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(ReviewSessionContextMissingError)
    }))

  it("rejects blank Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root, { sessionId: "   ", assistantText: "" })).pipe(
          Effect.flip,
        ),
      )
      expect(error).toBeInstanceOf(ReviewSessionContextMissingError)
    }))

  it("continues the Implement Session with /review and review model", () =>
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
        review(
          baseContext(root, {
            sessionId: "ses_from_implement",
            model: "opencode/build-model",
            variant: "high",
            reviewModel: "opencode/review-model",
            reviewVariant: "max",
            maxDuration: Duration.minutes(45),
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
      expect(continued!.model).toBe("opencode/review-model")
      expect(continued!.variant).toBe("max")
      expect(Duration.toMillis(continued!.timeout!)).toBe(
        Duration.toMillis(Duration.minutes(45)),
      )
      expect(continued!.prompt).toBe("/review")
    }))

  it("succeeds without interpreting review findings", () =>
    withTemp(async (root) => {
      await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () =>
            // OpenCode exit success alone is enough; findings are not a gate.
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "",
            }),
        }),
      )
    }))

  it("maps OpenCode exit failure", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
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
      expect(error).toBeInstanceOf(ReviewOpenCodeError)
      expect((error as ReviewOpenCodeError).worktreePath).toBe(root)
    }))

  it("maps OpenCode timeout failure", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
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
      expect(error).toBeInstanceOf(ReviewOpenCodeError)
    }))

  it("maps missing Session ID from OpenCode", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
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
      expect(error).toBeInstanceOf(ReviewOpenCodeError)
    }))
})
