import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  CurrentStepRun,
  limitAgentTurns,
} from "../src/lib/agent-turn-limiter.js"
import {
  REVIEW_PRE_COMMIT_MESSAGE,
  STEP_RUN_REASON,
  WAITING_FOR_AGENT_TURN_MESSAGE,
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
  thinkingLevel: "low",
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
         id, forge, forge_host, project_path, local_path, is_bare, paused,
         issues_reconciled_at, created_at, updated_at
       ) VALUES (?, 'github', 'github.com', 'o/r', ?, 1, 0, NULL, ?, ?)`,
      [input.repositoryId, `/tmp/${input.repositoryId}`, now, now],
    )
    yield* sql.unsafe(
      `INSERT INTO work_item (
         id, repository_id, issue_number, state, state_ready_at, worktree_path,
         session_id, failure_code, failure_message, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', ?,
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

/** Seed a bare Repository row with an optional guaranteed-minimum floor. */
const seedRepositoryGuarantee = (input: {
  readonly repositoryId: string
  readonly guaranteedMin: number | null
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = Date.now()
    yield* sql.unsafe(
      `INSERT INTO repository (
         id, forge, forge_host, project_path, local_path, is_bare, paused,
         guaranteed_min_concurrent_agent_turns,
         issues_reconciled_at, created_at, updated_at
       ) VALUES (?, 'github', 'github.com', 'o/r', ?, 1, 0, ?, NULL, ?, ?)`,
      [
        input.repositoryId,
        `/tmp/${input.repositoryId}`,
        input.guaranteedMin,
        now,
        now,
      ],
    )
  })

describe("limitAgentTurns", () => {
  it("caps concurrent start/continue to Config max and queues the rest", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
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

        const inner = AgentBackend.of({
          startTurn: () => gatedRun(),
          continueTurn: () => gatedRun(),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const first = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        const second = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        const third = yield* limited
          .continueTurn({
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

  it("does not count inspect toward the Agent Turn limit", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
          maxConcurrentWorkItems: 5,
        })

        const releaseStart = yield* Deferred.make<void>()
        const inspectStarted = yield* Deferred.make<void>()
        let startActive = false
        let inspectWhileStartActive = false

        const inner = AgentBackend.of({
          startTurn: () =>
            Effect.gen(function* () {
              startActive = true
              yield* Deferred.await(releaseStart)
              startActive = false
              return { sessionId: "ses_test", assistantText: "" }
            }),
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_test", assistantText: "" }),
          inspect: () =>
            Effect.gen(function* () {
              inspectWhileStartActive = startActive
              yield* Deferred.succeed(inspectStarted, undefined)
              return {
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [{ id: "model-a", thinkingLevels: ["low"] }],
              }
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const startFiber = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("20 millis")
        const models = yield* limited.inspect({ cwd: "/tmp" })
        yield* Deferred.await(inspectStarted)
        yield* Deferred.succeed(releaseStart, undefined)
        yield* Fiber.join(startFiber)

        expect(models.models).toEqual([
          { id: "model-a", thinkingLevels: ["low"] },
        ])
        expect(inspectWhileStartActive).toBe(true)
      }),
    ))

  it("admits a waiter when Config max is raised while a run is in flight", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
          maxConcurrentWorkItems: 5,
        })

        const releaseFirst = yield* Deferred.make<void>()
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let starts = 0

        const inner = AgentBackend.of({
          startTurn: () =>
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
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const first = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const second = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("50 millis")
        expect(starts).toBe(1)

        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
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
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
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

        const inner = AgentBackend.of({
          startTurn: () =>
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
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const first = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const second = yield* limited.startTurn(startInput).pipe(
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
          reason_code: STEP_RUN_REASON.waitingForAgentTurn,
          reason_message: WAITING_FOR_AGENT_TURN_MESSAGE,
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
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
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

        const inner = AgentBackend.of({
          startTurn: () =>
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
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const first = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const second = yield* limited.startTurn(startInput).pipe(
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
          reason_code: STEP_RUN_REASON.waitingForAgentTurn,
          reason_message: WAITING_FOR_AGENT_TURN_MESSAGE,
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

  it("grants a freed permit to whichever contending repository was least recently granted one", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
          maxConcurrentWorkItems: 5,
        })

        const repoA = "repo-fair-order-a"
        const repoB = "repo-fair-order-b"

        const admitted = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const releases = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const order: string[] = []
        let nextIndex = 0

        const inner = AgentBackend.of({
          startTurn: () =>
            Effect.gen(function* () {
              const current = yield* CurrentStepRun
              const index = nextIndex
              nextIndex += 1
              order.push(current?.repositoryId ?? "unknown")
              yield* Deferred.succeed(admitted[index]!, undefined)
              yield* Deferred.await(releases[index]!)
              return { sessionId: `ses_${index}`, assistantText: "" }
            }),
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const startFor = (repositoryId: string, stepRunId: string) =>
          limited.startTurn(startInput).pipe(
            Effect.provideService(CurrentStepRun, {
              stepRunId,
              repositoryId,
            }),
            Effect.forkChild,
          )

        // Repo A has no contention yet: admitted immediately, unchanged from
        // today's behavior.
        const a0 = yield* startFor(repoA, "srun-fair-order-a0")
        yield* Deferred.await(admitted[0]!)
        expect(order[0]).toBe(repoA)

        // Repo B (never yet granted) and a second Repo A request now both
        // have pending demand while the only permit is held by A's first run.
        const b0 = yield* startFor(repoB, "srun-fair-order-b0")
        const a1 = yield* startFor(repoA, "srun-fair-order-a1")
        yield* Effect.sleep("50 millis")
        expect(nextIndex).toBe(1)

        // Freeing the permit must go to Repo B: it has never been granted one,
        // while Repo A was just serviced, even though A's second request has
        // been queued the whole time too.
        yield* Deferred.succeed(releases[0]!, undefined)
        yield* Deferred.await(admitted[1]!)
        expect(order[1]).toBe(repoB)

        // With only Repo A's request left pending, it proceeds normally.
        yield* Deferred.succeed(releases[1]!, undefined)
        yield* Deferred.await(admitted[2]!)
        expect(order[2]).toBe(repoA)

        yield* Deferred.succeed(releases[2]!, undefined)
        yield* Fiber.join(a0)
        yield* Fiber.join(b0)
        yield* Fiber.join(a1)
      }),
    ))

  it("does not starve a low-volume repository behind a high-volume repository's continual demand", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
          maxConcurrentWorkItems: 5,
        })

        const repoHighVolume = "repo-fair-high-volume"
        const repoLowVolume = "repo-fair-low-volume"

        const TURN_COUNT = 5
        const admitted = Array.from(
          { length: TURN_COUNT },
          () => undefined as unknown as Deferred.Deferred<void>,
        )
        const releases = Array.from(
          { length: TURN_COUNT },
          () => undefined as unknown as Deferred.Deferred<void>,
        )
        for (let i = 0; i < TURN_COUNT; i += 1) {
          admitted[i] = yield* Deferred.make<void>()
          releases[i] = yield* Deferred.make<void>()
        }
        const order: string[] = []
        let nextIndex = 0

        const inner = AgentBackend.of({
          startTurn: () =>
            Effect.gen(function* () {
              const current = yield* CurrentStepRun
              const index = nextIndex
              nextIndex += 1
              order.push(current?.repositoryId ?? "unknown")
              yield* Deferred.succeed(admitted[index]!, undefined)
              yield* Deferred.await(releases[index]!)
              return { sessionId: `ses_${index}`, assistantText: "" }
            }),
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const startFor = (repositoryId: string, stepRunId: string) =>
          limited.startTurn(startInput).pipe(
            Effect.provideService(CurrentStepRun, {
              stepRunId,
              repositoryId,
            }),
            Effect.forkChild,
          )

        const high0 = yield* startFor(repoHighVolume, "srun-fair-high-0")
        yield* Deferred.await(admitted[0]!)
        expect(order[0]).toBe(repoHighVolume)

        // High-volume repo keeps generating fresh demand: three more requests
        // queue up behind its own first, in-flight run.
        const high1 = yield* startFor(repoHighVolume, "srun-fair-high-1")
        const high2 = yield* startFor(repoHighVolume, "srun-fair-high-2")
        const high3 = yield* startFor(repoHighVolume, "srun-fair-high-3")
        yield* Effect.sleep("50 millis")
        expect(nextIndex).toBe(1)

        // With no other repository contending yet, Repo A's own queued
        // request proceeds normally (single-repository contention: unchanged).
        yield* Deferred.succeed(releases[0]!, undefined)
        yield* Deferred.await(admitted[1]!)
        expect(order[1]).toBe(repoHighVolume)

        // Now the low-volume repo's one and only request arrives.
        const low0 = yield* startFor(repoLowVolume, "srun-fair-low-0")
        yield* Effect.sleep("50 millis")
        expect(nextIndex).toBe(2)

        // The low-volume repo must not be starved behind the high-volume
        // repo's remaining, heavier queued demand: it is least-recently
        // serviced (never granted), so it goes next.
        yield* Deferred.succeed(releases[1]!, undefined)
        yield* Deferred.await(admitted[2]!)
        expect(order[2]).toBe(repoLowVolume)

        // Once the low-volume repo has no more pending demand, it no longer
        // affects ordering: the high-volume repo's remaining requests proceed.
        yield* Deferred.succeed(releases[2]!, undefined)
        yield* Deferred.await(admitted[3]!)
        expect(order[3]).toBe(repoHighVolume)

        yield* Deferred.succeed(releases[3]!, undefined)
        yield* Deferred.await(admitted[4]!)
        expect(order[4]).toBe(repoHighVolume)

        yield* Deferred.succeed(releases[4]!, undefined)
        yield* Fiber.join(high0)
        yield* Fiber.join(high1)
        yield* Fiber.join(high2)
        yield* Fiber.join(high3)
        yield* Fiber.join(low0)
      }),
    ))

  it("releases the permit when an admitted Agent Turn is interrupted mid-flight", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
          maxConcurrentWorkItems: 5,
        })

        const started = yield* Deferred.make<void>()
        const neverRelease = yield* Deferred.make<void>()
        let callCount = 0

        const inner = AgentBackend.of({
          startTurn: () =>
            Effect.gen(function* () {
              callCount += 1
              if (callCount === 1) {
                yield* Deferred.succeed(started, undefined)
                // Never resolves on its own: only interruption ends this
                // turn, simulating Interrupt Work Item / Pause / a
                // productive timeout firing while it is actively running
                // and already holding the one available permit.
                yield* Deferred.await(neverRelease)
              }
              return { sessionId: `ses_${callCount}`, assistantText: "" }
            }),
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const first = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        yield* Fiber.interrupt(first)

        // If the permit were leaked on interrupt, this would time out
        // instead of being admitted, since capacity would never free up.
        const second = yield* limited
          .startTurn(startInput)
          .pipe(Effect.timeout("2 seconds"))

        expect(second.sessionId).toBe("ses_2")
      }),
    ))

  it("does not consume a permit when a queued Agent Turn is interrupted before admission", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
          maxConcurrentWorkItems: 5,
        })

        const releaseFirst = yield* Deferred.make<void>()
        const firstStarted = yield* Deferred.make<void>()
        let callCount = 0

        const inner = AgentBackend.of({
          startTurn: () =>
            Effect.gen(function* () {
              callCount += 1
              if (callCount === 1) {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(releaseFirst)
              }
              return { sessionId: `ses_${callCount}`, assistantText: "" }
            }),
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const first = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        // Second request is capacity-blocked and only queues; interrupt it
        // while it is still merely waiting (never admitted).
        const second = yield* limited
          .startTurn(startInput)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(second)

        // Release the first turn; a fresh third request should be admitted
        // immediately, proving the interrupted, never-admitted second
        // request left no stray demand or permit behind.
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)

        const third = yield* limited
          .startTurn(startInput)
          .pipe(Effect.timeout("2 seconds"))
        expect(third.sessionId).toBe("ses_2")
        expect(callCount).toBe(2)
      }),
    ))

  it("honors a Repository's guaranteed-minimum ahead of fair-share, even against heavier demand from another Repository", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })

        const repoGuaranteed = "repo-guaranteed-a"
        const repoOrdinary = "repo-ordinary-a"
        yield* seedRepositoryGuarantee({
          repositoryId: repoGuaranteed,
          guaranteedMin: 1,
        })

        const admitted = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const releases = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const order: string[] = []
        let nextIndex = 0

        const inner = AgentBackend.of({
          startTurn: () =>
            Effect.gen(function* () {
              const current = yield* CurrentStepRun
              const index = nextIndex
              nextIndex += 1
              order.push(current?.repositoryId ?? "unknown")
              yield* Deferred.succeed(admitted[index]!, undefined)
              yield* Deferred.await(releases[index]!)
              return { sessionId: `ses_${index}`, assistantText: "" }
            }),
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const startFor = (repositoryId: string, stepRunId: string) =>
          limited.startTurn(startInput).pipe(
            Effect.provideService(CurrentStepRun, {
              stepRunId,
              repositoryId,
            }),
            Effect.forkChild,
          )

        // Both permits are free and no contention yet: Ordinary's first two
        // requests are admitted immediately, unchanged from today.
        const o1 = yield* startFor(repoOrdinary, "srun-guar-o1")
        const o2 = yield* startFor(repoOrdinary, "srun-guar-o2")
        yield* Deferred.await(admitted[0]!)
        yield* Deferred.await(admitted[1]!)
        expect(order).toEqual([repoOrdinary, repoOrdinary])

        // A third Ordinary request and the Guaranteed repository's first
        // request now both queue behind the two held permits.
        const o3 = yield* startFor(repoOrdinary, "srun-guar-o3")
        const g1 = yield* startFor(repoGuaranteed, "srun-guar-g1")
        yield* Effect.sleep("50 millis")
        expect(nextIndex).toBe(2)

        // Freeing a permit must go to the Guaranteed repository: its floor
        // of 1 is unmet, which outranks Ordinary's older queued waiter.
        yield* Deferred.succeed(releases[0]!, undefined)
        yield* Deferred.await(admitted[2]!)
        expect(order[2]).toBe(repoGuaranteed)

        // With its guarantee now met, the remaining permit goes to Ordinary's
        // longest-waiting request as usual.
        yield* Deferred.succeed(releases[1]!, undefined)
        yield* Deferred.await(admitted[3]!)
        expect(order[3]).toBe(repoOrdinary)

        yield* Deferred.succeed(releases[2]!, undefined)
        yield* Deferred.succeed(releases[3]!, undefined)
        yield* Fiber.join(o1)
        yield* Fiber.join(o2)
        yield* Fiber.join(o3)
        yield* Fiber.join(g1)
      }),
    ))

  it("does not let an idle guaranteed-minimum withhold capacity, and reclaims it once demand returns", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 1,
          maxConcurrentWorkItems: 5,
        })

        const repoGuaranteed = "repo-guaranteed-idle"
        const repoOrdinary = "repo-ordinary-idle"
        yield* seedRepositoryGuarantee({
          repositoryId: repoGuaranteed,
          guaranteedMin: 1,
        })

        const admitted = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const releases = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const order: string[] = []
        let nextIndex = 0

        const inner = AgentBackend.of({
          startTurn: () =>
            Effect.gen(function* () {
              const current = yield* CurrentStepRun
              const index = nextIndex
              nextIndex += 1
              order.push(current?.repositoryId ?? "unknown")
              yield* Deferred.succeed(admitted[index]!, undefined)
              yield* Deferred.await(releases[index]!)
              return { sessionId: `ses_${index}`, assistantText: "" }
            }),
          continueTurn: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          inspect: () =>
            Effect.succeed({
              backend: { id: "opencode" as const, label: "OpenCode" },
              models: [],
            }),
        })
        const limited = yield* limitAgentTurns(inner, db, sql)

        const startFor = (repositoryId: string, stepRunId: string) =>
          limited.startTurn(startInput).pipe(
            Effect.provideService(CurrentStepRun, {
              stepRunId,
              repositoryId,
            }),
            Effect.forkChild,
          )

        // repoGuaranteed has a configured floor but no pending demand yet:
        // Ordinary's first request is admitted immediately, unblocked by the
        // idle guarantee.
        const o1 = yield* startFor(repoOrdinary, "srun-idle-o1")
        yield* Deferred.await(admitted[0]!)
        expect(order[0]).toBe(repoOrdinary)

        const o2 = yield* startFor(repoOrdinary, "srun-idle-o2")
        const g1 = yield* startFor(repoGuaranteed, "srun-idle-g1")
        yield* Effect.sleep("50 millis")
        expect(nextIndex).toBe(1)

        // repoGuaranteed now has demand again and reclaims its floor ahead
        // of Ordinary's own next waiter.
        yield* Deferred.succeed(releases[0]!, undefined)
        yield* Deferred.await(admitted[1]!)
        expect(order[1]).toBe(repoGuaranteed)

        yield* Deferred.succeed(releases[1]!, undefined)
        yield* Deferred.await(admitted[2]!)
        expect(order[2]).toBe(repoOrdinary)

        yield* Deferred.succeed(releases[2]!, undefined)
        yield* Fiber.join(o1)
        yield* Fiber.join(o2)
        yield* Fiber.join(g1)
      }),
    ))
})
