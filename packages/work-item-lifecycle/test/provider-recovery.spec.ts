import { Clock, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import {
  AGENT_BACKEND_IDS,
  AgentBackendExitError,
  getBuiltInAgentBackend,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  ImplementOpenCodeError,
  LifecycleSteps,
  type LifecycleStepsShape,
  STEP_RUN_REASON,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import {
  providerRecoveryJitterMs,
  providerRecoveryJitterSeed,
  scheduleProviderRecovery,
} from "../src/lib/provider-recovery-policy.js"
import { describe, expect, it } from "bun:test"

const codexRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.codex)
if (codexRegistration === undefined) {
  throw new Error("Codex Agent Backend registration is missing")
}

const provider = { id: "openai", label: "OpenAI" } as const

const capacityError = (retryAt?: number) =>
  new ImplementOpenCodeError({
    message: "Codex Build failed to implement",
    worktreePath: "/tmp/worktrees/acme-widgets-42",
    cause: AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp/worktrees/acme-widgets-42",
      classification: "retryable_provider_error",
      providerCode: "server_overloaded",
      model: "gpt-5.5",
      ...(retryAt === undefined ? {} : { retryAt }),
      message: "Selected model is at capacity. Please try a different model.",
    }),
  })

const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-42",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_kept"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () => Effect.succeed({ _tag: "clean" as const }),
  commit: () =>
    Effect.succeed({
      _tag: "committed" as const,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why\n\nCloses #1",
    }),
  createPr: () =>
    Effect.succeed({
      pullRequestNumber: 101,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why\n\nCloses #1",
    }),
  watchPrStatusChecks: () =>
    Effect.succeed({
      _tag: "succeeded",
      createdAt: new Date(0),
      headSha: "head",
      headPushedAt: new Date(0),
      isDraft: false,
    }),
  resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
  investigatePrStatusChecks: () =>
    Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
  markPrReadyForReview: () => Effect.succeed({ completion: "native" as const }),
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const lifecycleLayer = (steps: LifecycleStepsShape) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(
      stubActiveAgentBackendLayer({
        registration: codexRegistration,
        provider,
      }),
    ),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(stubLinearServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(TestClock.layer()),
  )

const run = <A, E>(
  steps: LifecycleStepsShape,
  effect: Effect.Effect<
    A,
    E,
    | WorkItemLifecycle
    | DbService
    | QueueService
    | SqlClient.SqlClient
    | TestClock.TestClock
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(lifecycleLayer(steps))))

type EpisodeRow = {
  readonly status: string
  readonly provider_id: string | null
  readonly model: string | null
  readonly provider_code: string | null
  readonly episode_started_at: number
  readonly attempt_count: number
  readonly next_attempt_at: number | null
  readonly generation: number
  readonly escalated: number | boolean
}

const isolateRecoveryJob = (sql: SqlClient.SqlClient) =>
  sql.unsafe(
    `DELETE FROM job_queue
     WHERE job_payload NOT LIKE '%"work-item-provider-recovery"%'`,
  )

const loadEpisode = (sql: SqlClient.SqlClient, workItemId: string) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT status, provider_id, model, provider_code, episode_started_at,
              attempt_count, next_attempt_at, generation, escalated
       FROM provider_recovery_episode
       WHERE work_item_id = ?`,
      [workItemId],
    )) as readonly EpisodeRow[]
    return rows[0] ?? null
  })

const seedImplementRun = Effect.gen(function* () {
  const db = yield* DbService
  const lifecycle = yield* WorkItemLifecycle
  const sql = yield* SqlClient.SqlClient
  yield* TestClock.setTime(1_000_000)
  const repo = yield* db.addRepository({
    forge: "github",
    forgeHost: "github.com",
    projectPath: "acme/widgets",
    localPath: "/repos/acme/widgets.git",
    isBare: true,
  })
  yield* db.updateConfig({
    selectedAgentBackend: "codex",
    defaultModel: "gpt-5.5",
    defaultThinkingLevel: "low",
    reviewModel: null,
    reviewThinkingLevel: null,
    maxConcurrentAgentTurns: 2,
    maxConcurrentWorkItems: 5,
  })
  yield* db.storeIssue({
    repositoryId: repo.id,
    issueNumber: 1,
    title: "Issue",
    body: "body",
    url: "https://github.com/acme/widgets/issues/1",
    state: "OPEN",
    githubCreatedAt: new Date(),
    issueAuthor: null,
    parent: null,
    parentPosition: null,
    hasChildren: false,
    blockedBy: [],
  })
  const created = yield* lifecycle.implementNow(repo.id, "1")
  const createRun = created.stepRuns[0]
  if (createRun === undefined) {
    return yield* Effect.die("expected create_worktree Step Run")
  }
  const afterCreate = yield* lifecycle.runStep(createRun.id)
  if (afterCreate._tag !== "processed") {
    return yield* Effect.die("expected create_worktree to process")
  }
  const installRun = afterCreate.workItem.stepRuns.find(
    (run) => run.step === "install_dependencies",
  )
  if (installRun === undefined) {
    return yield* Effect.die("expected install_dependencies Step Run")
  }
  const afterInstall = yield* lifecycle.runStep(installRun.id)
  if (afterInstall._tag !== "processed") {
    return yield* Effect.die("expected install_dependencies to process")
  }
  const implementRun = afterInstall.workItem.stepRuns.find(
    (run) => run.step === "implement",
  )
  if (implementRun === undefined) {
    return yield* Effect.die("expected implement Step Run")
  }
  yield* sql.unsafe(
    `UPDATE work_item
     SET session_id = ?, worktree_path = ?, updated_at = ?
     WHERE id = ?`,
    ["ses_kept", "/tmp/worktrees/acme-widgets-42", 1_000_000, created.id],
  )
  return {
    repositoryId: repo.id,
    workItemId: created.id,
    implementRunId: implementRun.id,
    db,
    lifecycle,
    sql,
  }
})

describe("Provider Recovery", () => {
  it("schedules a durable wake for a capacity failure without an operator Retry", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError()),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        const now = yield* Clock.currentTimeMillis
        const result = yield* seeded.lifecycle.runStep(seeded.implementRunId)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") return
        expect(result.workItem.holdsWorkerSlot).toBe(false)
        expect(result.workItem.waitingSince).toBeNull()
        expect(result.workItem.sessionId).toBe("ses_kept")
        expect(result.workItem.worktreePath).toBe(
          "/tmp/worktrees/acme-widgets-42",
        )
        const failed = result.workItem.stepRuns.find(
          (run) => run.id === seeded.implementRunId,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.transientProviderError)
        expect(
          result.workItem.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toHaveLength(0)

        const episode = yield* loadEpisode(seeded.sql, seeded.workItemId)
        expect(episode?.status).toBe("scheduled")
        expect(episode?.provider_id).toBe("openai")
        expect(episode?.model).toBe("gpt-5.5")
        expect(episode?.provider_code).toBe("server_overloaded")
        expect(episode?.attempt_count).toBe(1)
        expect(episode?.escalated).toBeFalsy()
        const expected = scheduleProviderRecovery({
          now,
          attempt: 1,
          episodeStartedAt: now,
          providerRetryAt: null,
          maxWaitMs: null,
          jitterSeed: providerRecoveryJitterSeed({
            workItemId: seeded.workItemId,
            episodeStartedAt: now,
            attempt: 1,
          }),
        })
        expect(expected._tag).toBe("schedule")
        if (expected._tag !== "schedule") return
        expect(episode?.next_attempt_at).toBe(expected.nextAttemptAt)

        const permits = (yield* seeded.sql.unsafe(
          `SELECT COUNT(*) AS count FROM autonomous_retry WHERE work_item_id = ?`,
          [seeded.workItemId],
        )) as readonly { readonly count: number }[]
        expect(Number(permits[0]?.count ?? 0)).toBe(0)

        yield* isolateRecoveryJob(seeded.sql)
        expect(
          Option.isNone(
            yield* (yield* QueueService).rawClaim(WORK_ITEM_LIFECYCLE_QUEUE),
          ),
        ).toBe(true)
        yield* TestClock.adjust(expected.nextAttemptAt - now)
        const queue = yield* QueueService
        const wake = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        expect(Option.isSome(wake)).toBe(true)
        if (Option.isNone(wake)) return
        const payload = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            _tag: Schema.Literal("work-item-provider-recovery"),
            generation: Schema.Finite,
            nextAttemptAt: Schema.Finite,
          }),
        )(wake.value.payload)
        const admitted = yield* seeded.lifecycle.wakeProviderRecovery({
          workItemId: seeded.workItemId,
          generation: payload.generation,
          nextAttemptAt: payload.nextAttemptAt,
        })
        expect(admitted).toEqual({ _tag: "woke" })
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.workItemId,
            generation: payload.generation,
            nextAttemptAt: payload.nextAttemptAt,
          }),
        ).toEqual({ _tag: "stale" })
        const resumed = yield* seeded.lifecycle.getWorkItem(seeded.workItemId)
        expect(resumed.sessionId).toBe("ses_kept")
        expect(resumed.worktreePath).toBe("/tmp/worktrees/acme-widgets-42")
        expect(resumed.stepRuns.at(-1)).toMatchObject({
          step: "implement",
          status: "queued",
        })
        expect(resumed.holdsWorkerSlot).toBe(true)
      }),
    )
  })

  it("ends the episode when the resumed turn succeeds", async () => {
    let calls = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => {
        calls += 1
        return calls === 1
          ? Effect.fail(capacityError())
          : Effect.succeed("ses_kept")
      },
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.lifecycle.runStep(seeded.implementRunId)
        const episode = yield* loadEpisode(seeded.sql, seeded.workItemId)
        yield* isolateRecoveryJob(seeded.sql)
        const delay = (episode?.next_attempt_at ?? 0) - 1_000_000
        yield* TestClock.adjust(delay)
        const queue = yield* QueueService
        const wake = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(wake)) {
          return yield* Effect.die("expected provider recovery wake")
        }
        const payload = wake.value.payload as {
          readonly generation: number
          readonly nextAttemptAt: number
        }
        yield* seeded.lifecycle.wakeProviderRecovery({
          workItemId: seeded.workItemId,
          generation: payload.generation,
          nextAttemptAt: payload.nextAttemptAt,
        })
        const resumed = yield* seeded.lifecycle.getWorkItem(seeded.workItemId)
        const queued = resumed.stepRuns.at(-1)
        if (queued === undefined) {
          return yield* Effect.die("expected resumed Step Run")
        }
        const succeeded = yield* seeded.lifecycle.runStep(queued.id)
        expect(succeeded._tag).toBe("processed")
        const after = yield* loadEpisode(seeded.sql, seeded.workItemId)
        expect(after?.status).toBe("recovered")
        expect(after?.next_attempt_at).toBeNull()
      }),
    )
  })

  it("does not schedule permanent or unknown failures", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(
          new ImplementOpenCodeError({
            message: "Codex Build failed to implement",
            worktreePath: "/tmp/worktrees/acme-widgets-42",
            cause: AgentBackendExitError.new({
              exitCode: 1,
              cwd: "/tmp/worktrees/acme-widgets-42",
              providerCode: "usage_limit_exceeded",
              message: "You have hit your usage limit.",
            }),
          }),
        ),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        const result = yield* seeded.lifecycle.runStep(seeded.implementRunId)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") return
        expect(
          result.workItem.stepRuns.find(
            (run) => run.id === seeded.implementRunId,
          )?.reasonCode,
        ).toBe(STEP_RUN_REASON.handlerFailed)
        expect(yield* loadEpisode(seeded.sql, seeded.workItemId)).toBeNull()
      }),
    )
  })

  it("respects a future provider deadline", async () => {
    const retryAt = 1_000_000 + 3_600_000
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError(retryAt)),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.lifecycle.runStep(seeded.implementRunId)
        const episode = yield* loadEpisode(seeded.sql, seeded.workItemId)
        expect(episode?.next_attempt_at).toBe(retryAt)
        const jitter = providerRecoveryJitterMs(
          providerRecoveryJitterSeed({
            workItemId: seeded.workItemId,
            episodeStartedAt: 1_000_000,
            attempt: 1,
          }),
          60_000,
        )
        expect(retryAt).toBeGreaterThan(1_000_000 + 60_000 + jitter)
      }),
    )
  })

  it("stops automatic retries when the configured maximum elapses and keeps the Session", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError()),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.db.setProviderRecoveryMaxWaitMs(30_000)
        const result = yield* seeded.lifecycle.runStep(seeded.implementRunId)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") return
        expect(
          result.workItem.stepRuns.find(
            (run) => run.id === seeded.implementRunId,
          )?.reasonCode,
        ).toBe(STEP_RUN_REASON.providerRecoveryExhausted)
        expect(result.workItem.sessionId).toBe("ses_kept")
        expect(result.workItem.state).toBe("implement")
        const episode = yield* loadEpisode(seeded.sql, seeded.workItemId)
        expect(episode?.status).toBe("exhausted")
        expect(episode?.next_attempt_at).toBeNull()
        yield* isolateRecoveryJob(seeded.sql)
        expect(
          Option.isNone(
            yield* (yield* QueueService).rawClaim(WORK_ITEM_LIFECYCLE_QUEUE),
          ),
        ).toBe(true)
      }),
    )
  })

  it("applies a later maximum wait against the original episode start", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError()),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.lifecycle.runStep(seeded.implementRunId)
        const scheduled = yield* loadEpisode(seeded.sql, seeded.workItemId)
        const startedAt = scheduled?.episode_started_at
        expect(startedAt).toBe(1_000_000)
        const listed = yield* seeded.db.listProviderRecoveryEpisodes
        expect(
          listed.find((row) => row.workItemId === seeded.workItemId),
        ).toMatchObject({
          status: "scheduled",
          providerLabel: "OpenAI",
          model: "gpt-5.5",
          attemptCount: 1,
          escalated: false,
        })
        // Setting change is later than the outage. A 30s cap is already past
        // if measured from the original start, and still in the future if
        // someone wrongly restarts the clock here.
        yield* TestClock.adjust(40_000)
        yield* seeded.db.setProviderRecoveryMaxWaitMs(30_000)
        expect(
          (yield* loadEpisode(seeded.sql, seeded.workItemId))
            ?.episode_started_at,
        ).toBe(startedAt)
        yield* isolateRecoveryJob(seeded.sql)
        yield* TestClock.adjust((scheduled?.next_attempt_at ?? 0) - 1_040_000)
        const queue = yield* QueueService
        const wake = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(wake)) {
          return yield* Effect.die("expected provider recovery wake")
        }
        const payload = wake.value.payload as {
          readonly generation: number
          readonly nextAttemptAt: number
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.workItemId,
            generation: payload.generation,
            nextAttemptAt: payload.nextAttemptAt,
          }),
        ).toEqual({ _tag: "exhausted" })
        const after = yield* seeded.lifecycle.getWorkItem(seeded.workItemId)
        expect(after.sessionId).toBe("ses_kept")
        expect(after.worktreePath).toBe("/tmp/worktrees/acme-widgets-42")
        expect(
          after.stepRuns.filter((run) => run.status === "queued"),
        ).toHaveLength(0)
        expect(
          (yield* loadEpisode(seeded.sql, seeded.workItemId))?.status,
        ).toBe("exhausted")
      }),
    )
  })

  it("still admits when a later generous maximum is inside the original episode", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError()),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.lifecycle.runStep(seeded.implementRunId)
        const scheduled = yield* loadEpisode(seeded.sql, seeded.workItemId)
        yield* TestClock.adjust(10_000)
        yield* seeded.db.setProviderRecoveryMaxWaitMs(2 * 3_600_000)
        expect(
          (yield* loadEpisode(seeded.sql, seeded.workItemId))
            ?.episode_started_at,
        ).toBe(1_000_000)
        yield* isolateRecoveryJob(seeded.sql)
        yield* TestClock.adjust((scheduled?.next_attempt_at ?? 0) - 1_010_000)
        const queue = yield* QueueService
        const wake = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(wake)) {
          return yield* Effect.die("expected provider recovery wake")
        }
        const payload = wake.value.payload as {
          readonly generation: number
          readonly nextAttemptAt: number
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.workItemId,
            generation: payload.generation,
            nextAttemptAt: payload.nextAttemptAt,
          }),
        ).toEqual({ _tag: "woke" })
      }),
    )
  })

  it("cancels a pending wake on Pause and does not admit after the deadline", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError()),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.lifecycle.runStep(seeded.implementRunId)
        const episode = yield* loadEpisode(seeded.sql, seeded.workItemId)
        yield* seeded.lifecycle.pause(seeded.workItemId)
        expect(
          (yield* loadEpisode(seeded.sql, seeded.workItemId))?.status,
        ).toBe("cancelled")
        yield* isolateRecoveryJob(seeded.sql)
        yield* TestClock.adjust((episode?.next_attempt_at ?? 0) - 1_000_000 + 1)
        const queue = yield* QueueService
        const wake = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(wake)) {
          return yield* Effect.die("expected stale wake job")
        }
        const payload = wake.value.payload as {
          readonly generation: number
          readonly nextAttemptAt: number
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.workItemId,
            generation: payload.generation,
            nextAttemptAt: payload.nextAttemptAt,
          }),
        ).toEqual({ _tag: "stale" })
        const after = yield* seeded.lifecycle.getWorkItem(seeded.workItemId)
        expect(after.stepRuns.at(-1)?.status).toBe("failed")
        expect(after.sessionId).toBe("ses_kept")
      }),
    )
  })

  it("lets manual Retry supersede the scheduled wake without a second turn", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError()),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.lifecycle.runStep(seeded.implementRunId)
        const before = yield* loadEpisode(seeded.sql, seeded.workItemId)
        const retried = yield* seeded.lifecycle.retry(seeded.workItemId)
        expect(retried.sessionId).toBe("ses_kept")
        expect(retried.stepRuns.at(-1)).toMatchObject({
          step: "implement",
          status: "queued",
        })
        expect(
          retried.stepRuns.filter((run) => run.status === "queued"),
        ).toHaveLength(1)
        yield* isolateRecoveryJob(seeded.sql)
        yield* TestClock.adjust((before?.next_attempt_at ?? 0) - 1_000_000)
        const queue = yield* QueueService
        const wake = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(wake)) {
          return yield* Effect.die("expected superseded wake job")
        }
        const payload = wake.value.payload as {
          readonly generation: number
          readonly nextAttemptAt: number
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.workItemId,
            generation: payload.generation,
            nextAttemptAt: payload.nextAttemptAt,
          }),
        ).toEqual({ _tag: "stale" })
        const after = yield* seeded.lifecycle.getWorkItem(seeded.workItemId)
        expect(
          after.stepRuns.filter((run) => run.status === "queued"),
        ).toHaveLength(1)
      }),
    )
  })

  it("releases the Worker Slot while waiting and re-enters admission when due", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () => Effect.fail(capacityError()),
    }
    await run(
      steps,
      Effect.gen(function* () {
        const seeded = yield* seedImplementRun
        yield* seeded.db.updateConfig({
          selectedAgentBackend: "codex",
          defaultModel: "gpt-5.5",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 1,
        })
        yield* seeded.sql.unsafe(
          `UPDATE work_item SET holds_worker_slot = 1, waiting_since = NULL WHERE id = ?`,
          [seeded.workItemId],
        )
        yield* seeded.db.storeIssue({
          repositoryId: seeded.repositoryId,
          issueNumber: 2,
          title: "Other",
          body: "body",
          url: "https://github.com/acme/widgets/issues/2",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const other = yield* seeded.lifecycle.implementNow(
          seeded.repositoryId,
          "2",
        )
        expect(other.holdsWorkerSlot).toBe(false)
        expect(other.waitingSince).not.toBeNull()

        const failed = yield* seeded.lifecycle.runStep(seeded.implementRunId)
        expect(failed._tag).toBe("processed")
        if (failed._tag !== "processed") return
        expect(failed.workItem.holdsWorkerSlot).toBe(false)
        const admittedOther = yield* seeded.lifecycle.getWorkItem(other.id)
        expect(admittedOther.holdsWorkerSlot).toBe(true)

        const episode = yield* loadEpisode(seeded.sql, seeded.workItemId)
        yield* isolateRecoveryJob(seeded.sql)
        yield* TestClock.adjust((episode?.next_attempt_at ?? 0) - 1_000_000)
        const queue = yield* QueueService
        const wake = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(wake)) {
          return yield* Effect.die("expected provider recovery wake")
        }
        const payload = wake.value.payload as {
          readonly generation: number
          readonly nextAttemptAt: number
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.workItemId,
            generation: payload.generation,
            nextAttemptAt: payload.nextAttemptAt,
          }),
        ).toEqual({ _tag: "woke" })
        const waiting = yield* seeded.lifecycle.getWorkItem(seeded.workItemId)
        expect(waiting.holdsWorkerSlot).toBe(false)
        expect(waiting.waitingSince).not.toBeNull()
        expect(
          waiting.stepRuns.filter((run) => run.status === "queued"),
        ).toHaveLength(0)

        yield* seeded.lifecycle.pause(other.id)
        const reentered = yield* seeded.lifecycle.getWorkItem(seeded.workItemId)
        expect(reentered.stepRuns.at(-1)).toMatchObject({
          step: "implement",
          status: "queued",
        })
        expect(reentered.sessionId).toBe("ses_kept")
      }),
    )
  })
})
