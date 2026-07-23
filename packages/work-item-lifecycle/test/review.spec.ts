import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbServiceLive } from "@ready-for-agent/db-service"
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
  ReviewResultError,
  ReviewSessionContextMissingError,
  ReviewWorktreeContextMissingError,
  makeWorkItemId,
  parseReviewResult,
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
  completionSummary: null,
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
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  readonly continue?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
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
        Effect.succeed({
          sessionId: "ses_review_default",
          assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
        }),
      listModels: () => Effect.succeed([]),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Opencode
    | Layer.Layer.Success<typeof PlatformLayer>
    | Layer.Layer.Success<typeof DbServiceLive>
    | Layer.Layer.Success<typeof DatabaseTest>
  >,
  opencodeLayer: Layer.Layer<Opencode, never, never> = stubOpencode({}),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(opencodeLayer),
      Effect.provide(DbServiceLive),
      Effect.provide(DatabaseTest),
      Effect.provide(PlatformLayer),
    ),
  )

const withTemp = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-review-"))
  try {
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("parseReviewResult", () => {
  it("parses clean and has-findings lines", () => {
    expect(parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_CLEAN")).toEqual({
      _tag: "clean",
    })
    expect(
      parseReviewResult(
        "Looks good overall.\nREADY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
      ),
    ).toEqual({ _tag: "has_findings" })
  })

  it("rejects missing, duplicate, non-final, or unknown markers", () => {
    expect(parseReviewResult("no result line")).toBeNull()
    expect(
      parseReviewResult(
        [
          "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
          "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
        ].join("\n"),
      ),
    ).toBeNull()
    expect(
      parseReviewResult(
        "READY_FOR_AGENT_RESULT: REVIEW_CLEAN\nAdditional output",
      ),
    ).toBeNull()
    expect(parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_FIXED")).toBeNull()
  })
})

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
        review(baseContext(root, { sessionId: "   " })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(ReviewSessionContextMissingError)
    }))

  it("continues the Implement Session with /review contract and review model", () =>
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

      const result = await run(
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
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            })
          },
        }),
      )

      expect(started).toBe(false)
      expect(result).toEqual({ _tag: "clean" })
      expect(continued).not.toBeNull()
      expect(continued!.sessionId).toBe("ses_from_implement")
      expect(continued!.cwd).toBe(root)
      expect(continued!.model).toBe("opencode/review-model")
      expect(continued!.variant).toBe("max")
      expect(Duration.toMillis(continued!.timeout!)).toBe(
        Duration.toMillis(Duration.minutes(45)),
      )
      expect(continued!.prompt).toContain("/review")
      expect(continued!.prompt).toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
      )
      expect(continued!.prompt).toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
      )
    }))

  it("returns clean for a unique final REVIEW_CLEAN marker", () =>
    withTemp(async (root) => {
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "No issues found.\nREADY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            }),
        }),
      )
      expect(result).toEqual({ _tag: "clean" })
    }))

  it("returns has_findings for a unique final REVIEW_HAS_FINDINGS marker", () =>
    withTemp(async (root) => {
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "Found a bug.\nREADY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
            }),
        }),
      )
      expect(result).toEqual({ _tag: "has_findings" })
    }))

  it("fails when READY_FOR_AGENT_RESULT is missing", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "Review complete with no machine line",
            }),
        }),
      )
      expect(error).toBeInstanceOf(ReviewResultError)
    }))

  it("fails when READY_FOR_AGENT_RESULT lines are duplicated", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: [
                "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
                "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
              ].join("\n"),
            }),
        }),
      )
      expect(error).toBeInstanceOf(ReviewResultError)
    }))

  it("fails when READY_FOR_AGENT_RESULT is not the final line", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_CLEAN\ntrailing prose",
            }),
        }),
      )
      expect(error).toBeInstanceOf(ReviewResultError)
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
