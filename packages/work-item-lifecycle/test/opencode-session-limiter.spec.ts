import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { Opencode } from "@ready-for-agent/opencode"
import {
  CurrentStepRun,
  limitOpencodeSessions,
} from "../src/lib/opencode-session-limiter.js"
import {
  REVIEW_PRE_COMMIT_MESSAGE,
  STEP_RUN_REASON,
  WAITING_FOR_OPENCODE_SESSION_MESSAGE,
} from "../src/lib/types.js"
import { describe, expect, it } from "bun:test"

const TestLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))

const runTest = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>,
) => Effect.runPromise(Effect.provide(effect, TestLayer))

const startInput = {
  prompt: "implement",
  cwd: "/tmp/worktree",
  model: "test/model",
  variant: "low",
}

const seedRunningStepRun = (input: {
  readonly stepRunId: string
  readonly workItemId: string
  readonly repositoryId: string
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = Date.now()
    yield* sql.unsafe(
      `INSERT INTO repository (
         id, github_owner, github_repo, local_path, is_bare, paused,
         issues_reconciled_at, created_at, updated_at
       ) VALUES (?, 'o', 'r', ?, 1, 0, NULL, ?, ?)`,
      [input.repositoryId, `/tmp/${input.repositoryId}`, now, now],
    )
    yield* sql.unsafe(
      `INSERT INTO work_item (
         id, repository_id, github_issue_number, model, variant,
         review_model, review_variant, state, state_ready_at, worktree_path,
         session_id, failure_code, failure_message, created_at, updated_at
       ) VALUES (?, ?, 1, 'm', 'v', 'm', 'v', 'implement', ?,
         '/tmp/worktree', NULL, NULL, NULL, ?, ?)`,
      [input.workItemId, input.repositoryId, now, now, now],
    )
    yield* sql.unsafe(
      `INSERT INTO step_run (
         id, work_item_id, step, status, queue_job_id, queued_at,
         started_at, finished_at, reason_code, reason_message,
         created_at, updated_at
       ) VALUES (?, ?, 'implement', 'running', NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [input.stepRunId, input.workItemId, now, now, now, now],
    )
  })

describe("limitOpencodeSessions", () => {
  it("caps concurrent start/continue to Config max and queues the rest", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 2,
          maxConcurrentWorkItems: 5,
        })

        const release = yield* Deferred.make<void>()
        const twoRunning = yield* Deferred.make<void>()
        const started = yield* Ref.make(0)
        const maximumActive = yield* Ref.make(0)
        const active = yield* Ref.make(0)

        const gatedRun = () =>
          Effect.gen(function* () {
            yield* Ref.update(active, (n) => n + 1)
            const current = yield* Ref.get(active)
            yield* Ref.update(maximumActive, (max) => Math.max(max, current))
            const count = yield* Ref.updateAndGet(started, (n) => n + 1)
            if (count === 2) {
              yield* Deferred.succeed(twoRunning, undefined)
            }
            yield* Deferred.await(release)
            yield* Ref.update(active, (n) => n - 1)
            return { sessionId: "ses_test", assistantText: "" }
          })

        const inner = Opencode.of({
          start: () => gatedRun(),
          continue: () => gatedRun(),
          listModels: () => Effect.succeed([]),
        })
        const limited = yield* limitOpencodeSessions(inner, db, sql)

        const first = yield* limited.start(startInput).pipe(Effect.forkChild)
        const second = yield* limited.start(startInput).pipe(Effect.forkChild)
        const third = yield* limited
          .continue({
            ...startInput,
            sessionId: "ses_existing",
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(twoRunning)
        expect(yield* Ref.get(started)).toBe(2)
        expect(yield* Ref.get(maximumActive)).toBe(2)
        expect(yield* Ref.get(active)).toBe(2)

        yield* Effect.sleep("50 millis")
        expect(yield* Ref.get(started)).toBe(2)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        yield* Fiber.join(third)

        expect(yield* Ref.get(started)).toBe(3)
        expect(yield* Ref.get(maximumActive)).toBe(2)
        expect(yield* Ref.get(active)).toBe(0)
      }),
    ))

  it("does not count listModels toward the OpenCode session limit", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 1,
          maxConcurrentWorkItems: 5,
        })

        const releaseStart = yield* Deferred.make<void>()
        const listModelsStarted = yield* Deferred.make<void>()
        let startActive = false
        let listModelsWhileStartActive = false

        const inner = Opencode.of({
          start: () =>
            Effect.gen(function* () {
              startActive = true
              yield* Deferred.await(releaseStart)
              startActive = false
              return { sessionId: "ses_test", assistantText: "" }
            }),
          continue: () =>
            Effect.succeed({ sessionId: "ses_test", assistantText: "" }),
          listModels: () =>
            Effect.gen(function* () {
              listModelsWhileStartActive = startActive
              yield* Deferred.succeed(listModelsStarted, undefined)
              return [{ id: "model-a", variants: ["low"] }]
            }),
        })
        const limited = yield* limitOpencodeSessions(inner, db, sql)

        const startFiber = yield* limited
          .start(startInput)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("20 millis")
        const models = yield* limited.listModels({ cwd: "/tmp" })
        yield* Deferred.await(listModelsStarted)
        yield* Deferred.succeed(releaseStart, undefined)
        yield* Fiber.join(startFiber)

        expect(models).toEqual([{ id: "model-a", variants: ["low"] }])
        expect(listModelsWhileStartActive).toBe(true)
      }),
    ))

  it("admits a waiter when Config max is raised while a run is in flight", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 1,
          maxConcurrentWorkItems: 5,
        })

        const releaseFirst = yield* Deferred.make<void>()
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let starts = 0

        const inner = Opencode.of({
          start: () =>
            Effect.gen(function* () {
              starts += 1
              if (starts === 1) {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(releaseFirst)
              } else {
                yield* Deferred.succeed(secondStarted, undefined)
              }
              return { sessionId: `ses_${starts}`, assistantText: "" }
            }),
          continue: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          listModels: () => Effect.succeed([]),
        })
        const limited = yield* limitOpencodeSessions(inner, db, sql)

        const first = yield* limited.start(startInput).pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const second = yield* limited.start(startInput).pipe(Effect.forkChild)
        yield* Effect.sleep("50 millis")
        expect(starts).toBe(1)

        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* Deferred.await(secondStarted)
        expect(starts).toBe(2)

        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    ))

  it("marks the ambient Step Run waiting while blocked on a session slot", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 1,
          maxConcurrentWorkItems: 5,
        })

        const repositoryId = "repo-limiter-wait"
        const workItemId = "wi-01JLIMITERWAIT000000000001"
        const stepRunId = "srun-01JLIMITERWAIT00000000001"
        yield* seedRunningStepRun({
          stepRunId,
          workItemId,
          repositoryId,
        })

        const releaseFirst = yield* Deferred.make<void>()
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let starts = 0

        const inner = Opencode.of({
          start: () =>
            Effect.gen(function* () {
              starts += 1
              if (starts === 1) {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(releaseFirst)
              } else {
                yield* Deferred.succeed(secondStarted, undefined)
              }
              return { sessionId: `ses_${starts}`, assistantText: "" }
            }),
          continue: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          listModels: () => Effect.succeed([]),
        })
        const limited = yield* limitOpencodeSessions(inner, db, sql)

        const first = yield* limited.start(startInput).pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const second = yield* limited.start(startInput).pipe(
          Effect.provideService(CurrentStepRun, {
            stepRunId,
            repositoryId,
          }),
          Effect.forkChild,
        )

        yield* Effect.sleep("50 millis")
        expect(starts).toBe(1)

        const waitingRows = (yield* sql.unsafe(
          `SELECT status, reason_code, reason_message, session_wait_started_at,
                  session_wait_ms
           FROM step_run WHERE id = ?`,
          [stepRunId],
        )) as readonly {
          readonly status: string
          readonly reason_code: string | null
          readonly reason_message: string | null
          readonly session_wait_started_at: number | null
          readonly session_wait_ms: number | null
        }[]
        expect(waitingRows[0]).toMatchObject({
          status: "running",
          reason_code: STEP_RUN_REASON.waitingForOpencodeSession,
          reason_message: WAITING_FOR_OPENCODE_SESSION_MESSAGE,
          session_wait_ms: 0,
        })
        expect(waitingRows[0]!.session_wait_started_at).toBeTypeOf("number")

        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(first)
        yield* Fiber.join(second)

        const afterRows = (yield* sql.unsafe(
          `SELECT status, reason_code, reason_message, session_wait_started_at,
                  session_wait_ms
           FROM step_run WHERE id = ?`,
          [stepRunId],
        )) as readonly {
          readonly status: string
          readonly reason_code: string | null
          readonly reason_message: string | null
          readonly session_wait_started_at: number | null
          readonly session_wait_ms: number | null
        }[]
        expect(afterRows[0]).toMatchObject({
          status: "running",
          reason_code: null,
          reason_message: null,
          session_wait_started_at: null,
        })
        expect(afterRows[0]!.session_wait_ms ?? 0).toBeGreaterThanOrEqual(40)
        expect(starts).toBe(2)
      }),
    ))

  it("restores a prior Review phase after waiting for a session slot", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 1,
          maxConcurrentWorkItems: 5,
        })

        const repositoryId = "repo-limiter-restore-phase"
        const workItemId = "wi-01JLIMITERREST000000000001"
        const stepRunId = "srun-01JLIMITERREST00000000001"
        yield* seedRunningStepRun({
          stepRunId,
          workItemId,
          repositoryId,
        })
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_code = ?, reason_message = ?, updated_at = ?
           WHERE id = ?`,
          [
            STEP_RUN_REASON.reviewPreCommit,
            REVIEW_PRE_COMMIT_MESSAGE,
            Date.now(),
            stepRunId,
          ],
        )

        const releaseFirst = yield* Deferred.make<void>()
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let starts = 0

        const inner = Opencode.of({
          start: () =>
            Effect.gen(function* () {
              starts += 1
              if (starts === 1) {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(releaseFirst)
              } else {
                yield* Deferred.succeed(secondStarted, undefined)
              }
              return { sessionId: `ses_${starts}`, assistantText: "" }
            }),
          continue: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          listModels: () => Effect.succeed([]),
        })
        const limited = yield* limitOpencodeSessions(inner, db, sql)

        const first = yield* limited.start(startInput).pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const second = yield* limited.start(startInput).pipe(
          Effect.provideService(CurrentStepRun, {
            stepRunId,
            repositoryId,
          }),
          Effect.forkChild,
        )

        yield* Effect.sleep("50 millis")
        expect(starts).toBe(1)

        const waitingRows = (yield* sql.unsafe(
          `SELECT reason_code, reason_message FROM step_run WHERE id = ?`,
          [stepRunId],
        )) as readonly {
          readonly reason_code: string | null
          readonly reason_message: string | null
        }[]
        expect(waitingRows[0]).toEqual({
          reason_code: STEP_RUN_REASON.waitingForOpencodeSession,
          reason_message: WAITING_FOR_OPENCODE_SESSION_MESSAGE,
        })

        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(first)
        yield* Fiber.join(second)

        const afterRows = (yield* sql.unsafe(
          `SELECT reason_code, reason_message FROM step_run WHERE id = ?`,
          [stepRunId],
        )) as readonly {
          readonly reason_code: string | null
          readonly reason_message: string | null
        }[]
        expect(afterRows[0]).toEqual({
          reason_code: STEP_RUN_REASON.reviewPreCommit,
          reason_message: REVIEW_PRE_COMMIT_MESSAGE,
        })
        expect(starts).toBe(2)
      }),
    ))
})
