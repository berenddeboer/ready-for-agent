import { Clock, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import {
  AGENT_BACKEND_IDS,
  AgentBackendExitError,
  getBuiltInAgentBackend,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import type { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  ImplementOpenCodeError,
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const codexRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.codex)
if (codexRegistration === undefined) {
  throw new Error("Codex Agent Backend registration is missing")
}

const provider = { id: "openai", label: "OpenAI" } as const

const capacityError = (input?: {
  readonly model?: string
  readonly providerCode?: string
  readonly retryAt?: number
  readonly accountId?: string
  readonly provider?: { readonly id: string; readonly label: string }
}) =>
  new ImplementOpenCodeError({
    message: "Codex Build failed to implement",
    worktreePath: "/tmp/worktrees/acme-widgets-42",
    cause: AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp/worktrees/acme-widgets-42",
      classification: "retryable_provider_error",
      providerCode: input?.providerCode ?? "server_overloaded",
      model: input?.model ?? "gpt-5.5",
      ...(input?.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input?.provider === undefined ? {} : { provider: input.provider }),
      ...(input?.retryAt === undefined ? {} : { retryAt: input.retryAt }),
      message: "Selected model is at capacity. Please try a different model.",
    }),
  })

const successfulSteps = (
  fail: () => ReturnType<typeof capacityError> | null,
): LifecycleStepsShape => ({
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-42",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => {
    const error = fail()
    return error === null ? Effect.succeed("ses_kept") : Effect.fail(error)
  },
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
})

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
  readonly work_item_id: string
  readonly status: string
  readonly model: string | null
  readonly provider_code: string | null
  readonly next_attempt_at: number | null
  readonly generation: number
  readonly cooldown_id: string | null
}

type CooldownRow = {
  readonly id: string
  readonly scope_key: string
  readonly scope_kind: string
  readonly backend: string
  readonly provider_id: string | null
  readonly account_id: string | null
  readonly model: string | null
  readonly next_attempt_at: number | null
  readonly probe_work_item_id: string | null
}

const loadEpisodes = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    return (yield* sql.unsafe(
      `SELECT work_item_id, status, model, provider_code, next_attempt_at,
              generation, cooldown_id
       FROM provider_recovery_episode`,
    )) as readonly EpisodeRow[]
  })

const loadCooldowns = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    return (yield* sql.unsafe(
      `SELECT id, scope_key, scope_kind, backend, provider_id, account_id,
              model, next_attempt_at, probe_work_item_id
       FROM provider_recovery_cooldown`,
    )) as readonly CooldownRow[]
  })

const queuedSteps = (sql: SqlClient.SqlClient, workItemId: string) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT COUNT(*) AS count FROM step_run
       WHERE work_item_id = ? AND status IN ('queued', 'running')`,
      [workItemId],
    )) as readonly { readonly count: number }[]
    return Number(rows[0]?.count ?? 0)
  })

const seedPair = Effect.gen(function* () {
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
  const advance = (issueNumber: number) =>
    Effect.gen(function* () {
      yield* db.storeIssue({
        repositoryId: repo.id,
        issueNumber,
        title: `Issue ${issueNumber}`,
        body: "body",
        url: `https://github.com/acme/widgets/issues/${issueNumber}`,
        state: "OPEN",
        githubCreatedAt: new Date(),
        issueAuthor: null,
        parent: null,
        parentPosition: null,
        hasChildren: false,
        blockedBy: [],
      })
      const created = yield* lifecycle.implementNow(
        repo.id,
        String(issueNumber),
      )
      let current = created
      for (const step of ["create_worktree", "install_dependencies"] as const) {
        const runId = current.stepRuns.find((row) => row.step === step)?.id
        if (runId === undefined) {
          return yield* Effect.die(`expected ${step}`)
        }
        const processed = yield* lifecycle.runStep(runId)
        if (processed._tag !== "processed") {
          return yield* Effect.die(`expected ${step} to process`)
        }
        current = processed.workItem
      }
      const implementRunId = current.stepRuns.find(
        (row) => row.step === "implement",
      )?.id
      if (implementRunId === undefined) {
        return yield* Effect.die("expected implement Step Run")
      }
      yield* sql.unsafe(
        `UPDATE work_item
       SET session_id = ?, worktree_path = ?, updated_at = ?
       WHERE id = ?`,
        ["ses_kept", "/tmp/worktrees/acme-widgets-42", 1_000_000, created.id],
      )
      return { workItemId: created.id, implementRunId }
    })
  const first = yield* advance(1)
  const second = yield* advance(2)
  return { db, lifecycle, sql, first, second, repositoryId: repo.id }
})

describe("Provider Recovery Cooldown", () => {
  it("suppresses a same-scope burst and lets an unrelated model proceed", async () => {
    let unrelated = false
    await run(
      successfulSteps(() =>
        capacityError(unrelated ? { model: "gpt-5.4" } : { model: "gpt-5.5" }),
      ),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        unrelated = true
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        const episodes = yield* loadEpisodes(seeded.sql)
        const cooldowns = yield* loadCooldowns(seeded.sql)
        expect(cooldowns).toHaveLength(2)
        expect(new Set(cooldowns.map((row) => row.scope_key)).size).toBe(2)
        expect(cooldowns.every((row) => row.scope_kind === "model")).toBe(true)
        expect(cooldowns.every((row) => row.account_id === null)).toBe(true)
        const first = episodes.find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        const second = episodes.find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        expect(first?.status).toBe("scheduled")
        expect(second?.status).toBe("scheduled")
        expect(first?.cooldown_id).not.toBe(second?.cooldown_id)
        const probe = cooldowns.find((row) => row.model === "gpt-5.4")
        expect(probe?.probe_work_item_id).toBe(seeded.second.workItemId)
        yield* TestClock.adjust((second?.next_attempt_at ?? 0) - 1_000_000)
        const admitted = yield* seeded.lifecycle.wakeProviderRecovery({
          workItemId: seeded.second.workItemId,
          generation: second?.generation ?? 0,
          nextAttemptAt: second?.next_attempt_at ?? 0,
        })
        expect(admitted).toEqual({ _tag: "woke" })
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(1)
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(0)
        const firstAfter = yield* seeded.lifecycle.getWorkItem(
          seeded.first.workItemId,
        )
        expect(firstAfter.holdsWorkerSlot).toBe(false)
      }),
    )
  })

  it("admits one probe, extends backoff on failure, and releases followers after success", async () => {
    let implementCalls = 0
    await run(
      successfulSteps(() => {
        implementCalls += 1
        return implementCalls <= 3 ? capacityError() : null
      }),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        const before = yield* loadEpisodes(seeded.sql)
        const probe = before.find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        const follower = before.find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        expect(probe?.next_attempt_at).not.toBeNull()
        expect(follower?.next_attempt_at).toBeGreaterThan(
          probe?.next_attempt_at ?? 0,
        )
        expect((yield* loadCooldowns(seeded.sql))[0]?.probe_work_item_id).toBe(
          seeded.first.workItemId,
        )
        yield* TestClock.adjust((follower?.next_attempt_at ?? 0) - 1_000_000)
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.second.workItemId,
            generation: follower?.generation ?? 0,
            nextAttemptAt: follower?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "deferred" })
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(0)
        expect(
          (yield* seeded.lifecycle.getWorkItem(seeded.second.workItemId))
            .holdsWorkerSlot,
        ).toBe(false)

        const results = yield* Effect.all(
          [
            seeded.lifecycle.wakeProviderRecovery({
              workItemId: seeded.first.workItemId,
              generation: probe?.generation ?? 0,
              nextAttemptAt: probe?.next_attempt_at ?? 0,
            }),
            seeded.lifecycle.wakeProviderRecovery({
              workItemId: seeded.first.workItemId,
              generation: probe?.generation ?? 0,
              nextAttemptAt: probe?.next_attempt_at ?? 0,
            }),
          ],
          { concurrency: 2 },
        )
        expect(results.filter((row) => row._tag === "woke")).toHaveLength(1)
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(1)
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(0)

        const resumed = yield* seeded.lifecycle.getWorkItem(
          seeded.first.workItemId,
        )
        const queued = resumed.stepRuns.at(-1)
        if (queued === undefined) {
          return yield* Effect.die("expected probe Step Run")
        }
        yield* seeded.lifecycle.runStep(queued.id)
        const extended = yield* loadEpisodes(seeded.sql)
        const followerAfterFailure = extended.find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        expect(followerAfterFailure?.next_attempt_at).toBeGreaterThan(
          follower?.next_attempt_at ?? 0,
        )
        expect(followerAfterFailure?.status).toBe("scheduled")

        const probeAgain = extended.find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        yield* TestClock.adjust(
          (probeAgain?.next_attempt_at ?? 0) - (follower?.next_attempt_at ?? 0),
        )
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.first.workItemId,
            generation: probeAgain?.generation ?? 0,
            nextAttemptAt: probeAgain?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "woke" })
        const secondAttempt = (yield* seeded.lifecycle.getWorkItem(
          seeded.first.workItemId,
        )).stepRuns.at(-1)
        if (secondAttempt === undefined) {
          return yield* Effect.die("expected second probe Step Run")
        }
        yield* seeded.lifecycle.runStep(secondAttempt.id)
        expect(
          (yield* loadEpisodes(seeded.sql)).find(
            (row) => row.work_item_id === seeded.first.workItemId,
          )?.status,
        ).toBe("recovered")
        expect(yield* loadCooldowns(seeded.sql)).toHaveLength(0)
        const released = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        expect(released?.status).toBe("scheduled")
        expect(released?.cooldown_id).toBeNull()
        expect(released?.next_attempt_at).not.toBe(probe?.next_attempt_at)
        const now = yield* Clock.currentTimeMillis
        yield* TestClock.adjust((released?.next_attempt_at ?? now) - now)
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.second.workItemId,
            generation: released?.generation ?? 0,
            nextAttemptAt: released?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "woke" })
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(1)
        expect(
          (yield* seeded.lifecycle.getWorkItem(seeded.second.workItemId))
            .sessionId,
        ).toBe("ses_kept")
      }),
    )
  })

  it("does not resume a paused probe owner and lets the other item probe", async () => {
    await run(
      successfulSteps(() => capacityError()),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        const before = yield* loadEpisodes(seeded.sql)
        const pausedEpisode = before.find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        yield* seeded.lifecycle.pause(seeded.first.workItemId)
        expect(
          (yield* loadEpisodes(seeded.sql)).find(
            (row) => row.work_item_id === seeded.first.workItemId,
          )?.status,
        ).toBe("cancelled")
        const cooldowns = yield* loadCooldowns(seeded.sql)
        expect(cooldowns[0]?.probe_work_item_id).toBe(seeded.second.workItemId)
        yield* TestClock.adjust(
          (pausedEpisode?.next_attempt_at ?? 0) - 1_000_000 + 1,
        )
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.first.workItemId,
            generation: pausedEpisode?.generation ?? 0,
            nextAttemptAt: pausedEpisode?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "stale" })
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(0)
        const promoted = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        const now = yield* Clock.currentTimeMillis
        if ((promoted?.next_attempt_at ?? 0) > now) {
          yield* TestClock.adjust((promoted?.next_attempt_at ?? 0) - now)
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.second.workItemId,
            generation: promoted?.generation ?? 0,
            nextAttemptAt: promoted?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "woke" })
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(1)
        expect(
          (yield* seeded.lifecycle.getWorkItem(seeded.first.workItemId)).paused,
        ).toBe(true)
      }),
    )
  })

  it("recovers an abandoned probe after restart without a second admission", async () => {
    await run(
      successfulSteps(() => capacityError()),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        yield* seeded.sql.unsafe(
          `UPDATE provider_recovery_episode
           SET status = 'in_attempt', next_attempt_at = NULL, generation = generation + 1
           WHERE work_item_id = ?`,
          [seeded.first.workItemId],
        )
        yield* seeded.lifecycle.interruptRunningStepRunsFromPriorWorker
        const recovered = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        expect(recovered?.status).toBe("scheduled")
        expect((yield* loadCooldowns(seeded.sql))[0]?.probe_work_item_id).toBe(
          seeded.first.workItemId,
        )
        const now = yield* Clock.currentTimeMillis
        if ((recovered?.next_attempt_at ?? 0) > now) {
          yield* TestClock.adjust((recovered?.next_attempt_at ?? 0) - now)
        }
        const wakes = yield* Effect.all(
          [
            seeded.lifecycle.wakeProviderRecovery({
              workItemId: seeded.first.workItemId,
              generation: recovered?.generation ?? 0,
              nextAttemptAt: recovered?.next_attempt_at ?? now,
            }),
            seeded.lifecycle.wakeProviderRecovery({
              workItemId: seeded.second.workItemId,
              generation:
                (yield* loadEpisodes(seeded.sql)).find(
                  (row) => row.work_item_id === seeded.second.workItemId,
                )?.generation ?? 0,
              nextAttemptAt:
                (yield* loadEpisodes(seeded.sql)).find(
                  (row) => row.work_item_id === seeded.second.workItemId,
                )?.next_attempt_at ?? 0,
            }),
          ],
          { concurrency: 2 },
        )
        expect(wakes.filter((row) => row._tag === "woke")).toHaveLength(1)
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(1)
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(0)
      }),
    )
  })

  it("shares a provider-wide rate limit across models and keeps other providers moving", async () => {
    let phase: "wide" | "other" = "wide"
    await run(
      successfulSteps(() =>
        phase === "wide"
          ? capacityError({
              providerCode: "usage_limit_exceeded",
              model: "gpt-5.5",
            })
          : capacityError({
              providerCode: "server_overloaded",
              model: "gpt-5.5",
              provider: { id: "bedrock", label: "Amazon Bedrock" },
            }),
      ),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        phase = "other"
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        const cooldowns = yield* loadCooldowns(seeded.sql)
        expect(cooldowns).toHaveLength(2)
        const wide = cooldowns.find((row) => row.scope_kind === "provider")
        const other = cooldowns.find((row) => row.provider_id === "bedrock")
        expect(wide?.model).toBeNull()
        expect(wide?.provider_id).toBe("openai")
        expect(other?.backend).toBe("codex")
        expect(wide?.scope_key).not.toBe(other?.scope_key)
        const otherEpisode = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        yield* TestClock.adjust(
          (otherEpisode?.next_attempt_at ?? 0) - 1_000_000,
        )
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.second.workItemId,
            generation: otherEpisode?.generation ?? 0,
            nextAttemptAt: otherEpisode?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "woke" })
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(1)
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(0)
      }),
    )
  })

  it("does not persist a credential as the account key and separates safe accounts", async () => {
    let accountId = "api_key_production"
    await run(
      successfulSteps(() => capacityError({ accountId })),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        expect((yield* loadCooldowns(seeded.sql))[0]?.account_id).toBeNull()
        accountId = "acct_chatgpt_2"
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        const cooldowns = yield* loadCooldowns(seeded.sql)
        expect(cooldowns).toHaveLength(2)
        expect(cooldowns.map((row) => row.account_id)).toContain(
          "acct_chatgpt_2",
        )
        expect(cooldowns.filter((row) => row.account_id === null)).toHaveLength(
          1,
        )
        expect(cooldowns.some((row) => row.scope_key.includes("api_key"))).toBe(
          false,
        )
      }),
    )
  })

  it("keeps a shared deadline from outrunning an item's own elapsed limit", async () => {
    let retryAt = 0
    await run(
      successfulSteps(() => capacityError({ retryAt })),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.db.setProviderRecoveryMaxWaitMs(150_000)
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        yield* TestClock.adjust(80_000)
        retryAt = 1_000_000 + 200_000
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        const episodes = yield* loadEpisodes(seeded.sql)
        const older = episodes.find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        const newer = episodes.find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        expect(older?.status).toBe("exhausted")
        expect(older?.next_attempt_at).toBeNull()
        expect(newer?.status).toBe("scheduled")
        expect(newer?.next_attempt_at).toBeGreaterThanOrEqual(retryAt)
        expect((yield* loadCooldowns(seeded.sql))[0]?.probe_work_item_id).toBe(
          seeded.second.workItemId,
        )
      }),
    )
  })

  it("does not give a cooling follower a worker slot ahead of ordinary waiters", async () => {
    await run(
      successfulSteps(() => capacityError()),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.db.updateConfig({
          selectedAgentBackend: "codex",
          defaultModel: "gpt-5.5",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 1,
        })
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        const holder = yield* seeded.lifecycle.getWorkItem(
          seeded.first.workItemId,
        )
        expect(holder.holdsWorkerSlot).toBe(false)
        yield* seeded.sql.unsafe(
          `UPDATE work_item SET holds_worker_slot = 1, waiting_since = NULL WHERE id = ?`,
          [seeded.first.workItemId],
        )
        const follower = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        yield* TestClock.adjust((follower?.next_attempt_at ?? 0) - 1_000_000)
        const probe = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.first.workItemId,
            generation: probe?.generation ?? 0,
            nextAttemptAt: probe?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "woke" })
        const waitingProbe = yield* seeded.lifecycle.getWorkItem(
          seeded.first.workItemId,
        )
        expect(waitingProbe.holdsWorkerSlot).toBe(true)
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.second.workItemId,
            generation: follower?.generation ?? 0,
            nextAttemptAt: follower?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "deferred" })
        const stillWaiting = yield* seeded.lifecycle.getWorkItem(
          seeded.second.workItemId,
        )
        expect(stillWaiting.holdsWorkerSlot).toBe(false)
        expect(stillWaiting.waitingSince).toBeNull()
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(0)
      }),
    )
  })

  it("does not start a second turn when a CI hold on the probe lifts", async () => {
    await run(
      successfulSteps(() => capacityError()),
      Effect.gen(function* () {
        const seeded = yield* seedPair
        yield* seeded.lifecycle.runStep(seeded.first.implementRunId)
        yield* seeded.lifecycle.runStep(seeded.second.implementRunId)
        yield* seeded.sql.unsafe(
          `INSERT INTO ci_gate_definition_observation (
             id, repository_id, definition_identity, failure_latched,
             last_early_job_failure, created_at, updated_at
           ) VALUES ('cgo-test', ?, 'gate', 1, 0, 1, 1)`,
          [seeded.repositoryId],
        )
        const probe = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        yield* TestClock.adjust((probe?.next_attempt_at ?? 0) - 1_000_000)
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.first.workItemId,
            generation: probe?.generation ?? 0,
            nextAttemptAt: probe?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "woke" })
        const held = yield* seeded.lifecycle.getWorkItem(
          seeded.first.workItemId,
        )
        expect(held.waitingForCiRepair).toBe(true)
        expect(held.holdsWorkerSlot).toBe(false)
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(0)
        const parked = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        expect(parked?.status).toBe("scheduled")
        expect((yield* loadCooldowns(seeded.sql))[0]?.probe_work_item_id).toBe(
          seeded.second.workItemId,
        )

        yield* seeded.sql.unsafe(
          `UPDATE ci_gate_definition_observation SET failure_latched = 0`,
        )
        const promoted = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.second.workItemId,
        )
        const now = yield* Clock.currentTimeMillis
        if ((promoted?.next_attempt_at ?? 0) > now) {
          yield* TestClock.adjust((promoted?.next_attempt_at ?? 0) - now)
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.second.workItemId,
            generation: promoted?.generation ?? 0,
            nextAttemptAt: promoted?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "woke" })
        expect(yield* queuedSteps(seeded.sql, seeded.second.workItemId)).toBe(1)

        yield* seeded.lifecycle.releaseWaitingForCiRepair(seeded.repositoryId)
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(0)
        const resumed = (yield* loadEpisodes(seeded.sql)).find(
          (row) => row.work_item_id === seeded.first.workItemId,
        )
        const releasedAt = yield* Clock.currentTimeMillis
        if ((resumed?.next_attempt_at ?? 0) > releasedAt) {
          yield* TestClock.adjust((resumed?.next_attempt_at ?? 0) - releasedAt)
        }
        expect(
          yield* seeded.lifecycle.wakeProviderRecovery({
            workItemId: seeded.first.workItemId,
            generation: resumed?.generation ?? 0,
            nextAttemptAt: resumed?.next_attempt_at ?? 0,
          }),
        ).toEqual({ _tag: "deferred" })
        expect(yield* queuedSteps(seeded.sql, seeded.first.workItemId)).toBe(0)
      }),
    )
  })
})
