import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  Opencode,
  OpencodeExitError,
  OpencodeTimeoutError,
  SessionIdNotFoundError,
} from "@ready-for-agent/opencode"
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
  variant: "high",
  worktreePath,
  sessionId: null,
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
  }) => Effect.Effect<{ sessionId: string }, never>
}) =>
  Layer.succeed(
    Opencode,
    Opencode.of({
      start: (input) =>
        impl.start?.(input) ??
        Effect.succeed({ sessionId: "ses_implement_default" }),
      continue: (input) =>
        impl.continue?.(input) ??
        Effect.succeed({ sessionId: "ses_continue_should_not_run" }),
      listModels: () => Effect.succeed([]),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Layer.Layer.Success<typeof PlatformLayer>
    | Layer.Layer.Success<typeof DbServiceLive>
    | Opencode
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

  it("starts OpenCode with exact issue identity, worktree, model, and variant", () =>
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
              variant: "max",
              sessionId: "ses_install_fallback_must_ignore",
              maxDuration: Duration.minutes(90),
            }),
          )
        }),
        stubOpencode({
          start: (input) => {
            started = input
            return Effect.succeed({ sessionId: "ses_fresh_implement" })
          },
          continue: () => {
            continued = true
            return Effect.succeed({ sessionId: "ses_wrong" })
          },
        }),
      )

      expect(sessionId).toBe("ses_fresh_implement")
      expect(started).not.toBeNull()
      expect(started!.cwd).toBe(root)
      expect(started!.model).toBe("opencode/implement-model")
      expect(started!.variant).toBe("max")
      expect(Duration.toMillis(started!.timeout!)).toBe(
        Duration.toMillis(Duration.minutes(90)),
      )
      expect(started!.prompt).toContain("acme/widgets#80")
      expect(started!.prompt).toContain("Inspect the current GitHub Issue")
      expect(started!.prompt).toContain("run appropriate verification")
      expect(started!.prompt).toContain("Do not merely propose a plan")
      expect(continued).toBe(false)
    }))

  it("always starts a fresh Session despite an earlier installation Session", () =>
    withTemp(async (root) => {
      const calls: string[] = []
      let continueCalls = 0

      const first = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              repositoryId: repository.id,
              sessionId: "ses_from_install_fallback",
            }),
          )
        }),
        stubOpencode({
          start: () => {
            calls.push("start-1")
            return Effect.succeed({ sessionId: "ses_first_implement" })
          },
          continue: () => {
            continueCalls += 1
            return Effect.succeed({ sessionId: "ses_should_not" })
          },
        }),
      )

      expect(first).toBe("ses_first_implement")
      expect(calls).toEqual(["start-1"])
      expect(continueCalls).toBe(0)

      // Retry is re-entrant: another Implement run starts a new Session even
      // when context still carries the previous Session id.
      const second = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          return yield* implement(
            baseContext(root, {
              repositoryId: repository.id,
              sessionId: first,
            }),
          )
        }),
        stubOpencode({
          start: () => {
            calls.push("start-2")
            return Effect.succeed({ sessionId: "ses_retry_implement" })
          },
          continue: () => {
            continueCalls += 1
            return Effect.succeed({ sessionId: "ses_should_not" })
          },
        }),
      )

      expect(second).toBe("ses_retry_implement")
      expect(calls).toEqual(["start-1", "start-2"])
      expect(continueCalls).toBe(0)
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
          Opencode,
          Opencode.of({
            start: () =>
              Effect.fail(new OpencodeExitError({ exitCode: 2, cwd: root })),
            continue: () => Effect.succeed({ sessionId: "unused" }),
            listModels: () => Effect.succeed([]),
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
          Opencode,
          Opencode.of({
            start: () =>
              Effect.fail(
                new OpencodeTimeoutError({ cwd: root, timeoutMs: 1_000 }),
              ),
            continue: () => Effect.succeed({ sessionId: "unused" }),
            listModels: () => Effect.succeed([]),
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
          Opencode,
          Opencode.of({
            start: () => Effect.fail(new SessionIdNotFoundError({ cwd: root })),
            continue: () => Effect.succeed({ sessionId: "unused" }),
            listModels: () => Effect.succeed([]),
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
          start: () => Effect.succeed({ sessionId: "   " }),
        }),
      )
      expect(error).toBeInstanceOf(ImplementOpenCodeError)
      expect((error as ImplementOpenCodeError).message).toContain("Session ID")
    }))
})
