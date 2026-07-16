import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
} from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DatabaseError,
  DbService,
  DbServiceLive,
  RepositoryId,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import { createGraphqlApi } from "@ready-for-agent/graphql-api"
import {
  IssueReconciler,
  IssueReconcilerLive,
  type IssueReconcilerShape,
} from "@ready-for-agent/issue-reconciler"
import {
  KeymaxxerError,
  KeymaxxerService,
} from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import {
  ClaimError,
  QueueService,
  type QueueServiceShape,
  type RawJob,
  makeJobId,
} from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  WorkItemLifecycle,
  WorkItemStepJob,
  makeStepRunId,
} from "@ready-for-agent/work-item-lifecycle"
import {
  ISSUE_POLL_QUEUE,
  ISSUE_REFRESH_QUEUE,
  JOBS_QUEUE,
  JOB_RECOVERY_RETRY_LIMIT,
  JOB_VISIBILITY_TIMEOUT,
  POLLING_AUTO_HEAL_KEY,
  enqueuePollingAutoHealJob,
  enqueueRefreshRepositoryJob,
  runJobWorker,
  startJobWorker,
  transferPersistedRefreshJobs,
} from "../src/server/job-worker.js"
import { describe, expect, test } from "bun:test"

const repository = makeRepositoryRecord({
  id: "repo-01J00000000000000000000000",
  paused: true,
})

const otherRepository = makeRepositoryRecord({
  id: "repo-01J00000000000000000000001",
  githubOwner: "acme",
  githubRepo: "gadgets",
  localPath: "/repos/acme/gadgets.git",
  paused: true,
})

const refreshPayload = {
  _tag: "refresh-repository" as const,
  repositoryId: RepositoryId.make(repository.id),
}

const rawJob = (
  payload: unknown,
  queue: string = ISSUE_REFRESH_QUEUE,
  key: string | null = null,
): RawJob => {
  const now = DateTime.makeUnsafe(0)
  return {
    jobId: makeJobId(),
    queue,
    key,
    payload,
    attempts: 1,
    maxAttempts: 2,
    availableAt: now,
    lockedUntil: now,
  }
}

const unused = () => Effect.die("not used")

const dbLayer = (
  repositories: readonly RepositoryRecord[] = [repository],
  notifyIssuesChanged: (repositoryId: string) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  stubDbServiceLayer({
    notifyIssuesChanged,
    listRepositories: Effect.succeed(repositories),
  })

const keymaxxerLayer = (
  credentialedAccounts: ReadonlySet<string> = new Set([
    `${repository.githubOwner}/${repository.githubRepo}`,
    `${otherRepository.githubOwner}/${otherRepository.githubRepo}`,
  ]),
) =>
  Layer.succeed(KeymaxxerService, {
    initialize: Effect.void,
    findSecret: ({ account, provider }) =>
      Effect.succeed(
        provider === "github" && credentialedAccounts.has(account)
          ? `GITHUB_TOKEN_${account.replace("/", "_").toUpperCase()}`
          : null,
      ),
    findSecrets: () => Effect.die("not used"),
    hasSecret: () => Effect.die("not used"),
    addSecret: () => Effect.die("not used"),
    removeSecret: () => Effect.die("not used"),
    runWithSecrets: () => Effect.die("not used"),
  })

const queueLayer = (
  jobs: RawJob[],
  onAcknowledge: (jobId: string) => Effect.Effect<unknown> = () => Effect.void,
  onFail: (jobId: string) => Effect.Effect<unknown> = () => Effect.void,
  onClaim?: (queue: string) => Effect.Effect<Option.Option<RawJob>, ClaimError>,
  runStep: (
    stepRunId: string,
  ) => Effect.Effect<{ readonly _tag: "noop" }> = () =>
    Effect.succeed({ _tag: "noop" as const }),
  onExtendVisibility: (
    jobId: string,
    timeout: Duration.Duration,
  ) => Effect.Effect<unknown> = () => Effect.void,
  recoverOrphanedStepRuns: Effect.Effect<number> = Effect.succeed(0),
  onPostponeKeyed: (
    jobId: string,
    delay: Duration.Duration,
  ) => Effect.Effect<unknown> = () => Effect.void,
) =>
  Layer.merge(
    Layer.succeed(QueueService, {
      queueInTransaction: true,
      enqueue: unused,
      enqueueWithDelay: unused,
      ensureKeyed: unused,
      listKeyed: unused,
      postponeKeyed: (jobId, delay) =>
        onPostponeKeyed(jobId, delay).pipe(Effect.asVoid),
      removeKeyed: unused,
      rawClaim: (queueName, visibilityTimeout) =>
        Effect.gen(function* () {
          expect(Duration.toMillis(visibilityTimeout ?? Duration.zero)).toBe(
            Duration.toMillis(JOB_VISIBILITY_TIMEOUT),
          )
          if (onClaim !== undefined) return yield* onClaim(queueName)
          const index = jobs.findIndex((job) => job.queue === queueName)
          if (index === -1) return Option.none()
          const [job] = jobs.splice(index, 1)
          return Option.some(job)
        }),
      acknowledge: (jobId) => onAcknowledge(jobId).pipe(Effect.asVoid),
      fail: (jobId, options) =>
        Effect.gen(function* () {
          expect(options?.retryable).toBe(false)
          yield* onFail(jobId)
        }),
      extendVisibility: (jobId, timeout) =>
        onExtendVisibility(jobId, timeout).pipe(Effect.asVoid),
      getStats: unused,
      requeueByPayloadTag: () => Effect.succeed(0),
    } satisfies QueueServiceShape),
    Layer.succeed(WorkItemLifecycle, {
      maxDurations: {
        create_worktree: Duration.minutes(5),
        install_dependencies: Duration.minutes(15),
        implement: Duration.hours(2),
        pre_commit: Duration.hours(2),
        review: Duration.hours(1),
        commit: Duration.minutes(5),
        create_pr: Duration.minutes(10),
        watch_pr_status_checks: Duration.minutes(5),
        resolve_pr_merge_conflict: Duration.hours(2),
        investigate_pr_status_checks: Duration.hours(2),
        mark_pr_ready_for_review: Duration.minutes(5),
        decide_pr_merge: Duration.minutes(15),
        merge_pr: Duration.minutes(5),
        local_cleanup: Duration.minutes(5),
      },
      implementNow: unused,
      implementLocally: unused,
      recoverOrphanedStepRuns,
      runStep,
      retry: unused,
      pause: unused,
      start: unused,
      abandon: unused,
      reset: unused,
      getWorkItem: unused,
      listWorkItemsForIssue: unused,
      listWorkItemsForRepository: unused,
    }),
  )

const runScoped = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R>,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(layer), Effect.orDie),
  )

describe("Job worker", () => {
  test("enqueues a validated Refresh Job on the issue-refresh queue", async () => {
    let enqueued:
      | {
          queue: string
          payload: Record<string, unknown>
          retryLimit: number | undefined
        }
      | undefined
    const queue = Layer.succeed(QueueService, {
      queueInTransaction: true,
      enqueue: (queueName, payload, options) =>
        Effect.sync(() => {
          enqueued = {
            queue: queueName,
            payload,
            retryLimit: options?.retryLimit,
          }
          return makeJobId()
        }),
      enqueueWithDelay: unused,
      ensureKeyed: unused,
      listKeyed: unused,
      postponeKeyed: unused,
      removeKeyed: unused,
      rawClaim: unused,
      acknowledge: unused,
      fail: unused,
      extendVisibility: unused,
      getStats: unused,
      requeueByPayloadTag: () => Effect.succeed(0),
    } satisfies QueueServiceShape)

    await Effect.runPromise(
      enqueueRefreshRepositoryJob(refreshPayload.repositoryId).pipe(
        Effect.provide(queue),
      ),
    )

    expect(enqueued).toEqual({
      queue: ISSUE_REFRESH_QUEUE,
      payload: refreshPayload,
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
  })

  test("extends a Lifecycle Job lease and leaves a live no-op unacknowledged", async () => {
    const stepRunId = makeStepRunId()
    const payload = WorkItemStepJob.make({ stepRunId })
    const job = rawJob(payload, JOBS_QUEUE)
    const dispatched = await Effect.runPromise(Deferred.make<string>())
    const extended = await Effect.runPromise(
      Deferred.make<{ readonly jobId: string; readonly timeoutMs: number }>(),
    )
    const recovered = await Effect.runPromise(Deferred.make<void>())
    const acknowledged: string[] = []

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Deferred.await(recovered)
        expect(yield* Deferred.await(dispatched)).toBe(stepRunId)
        expect(yield* Deferred.await(extended)).toEqual({
          jobId: job.jobId,
          timeoutMs: Duration.toMillis(Duration.hours(2)) + 60_000,
        })
        yield* Effect.sleep("10 millis")
        expect(acknowledged).toEqual([])
      }),
      Layer.mergeAll(
        queueLayer(
          [job],
          (jobId) =>
            Effect.sync(() => {
              acknowledged.push(jobId)
            }),
          undefined,
          undefined,
          (receivedStepRunId) =>
            Deferred.succeed(dispatched, receivedStepRunId).pipe(
              Effect.as({ _tag: "noop" as const }),
            ),
          (jobId, timeout) =>
            Deferred.succeed(extended, {
              jobId,
              timeoutMs: Duration.toMillis(timeout),
            }),
          Deferred.succeed(recovered, undefined).pipe(Effect.as(0)),
        ),
        dbLayer(),
        Layer.succeed(IssueReconciler, { reconcile: unused }),
        keymaxxerLayer(),
      ),
    )
  })

  test("rechecks orphan recovery while the worker is running", async () => {
    let recoveryCalls = 0
    const recoveredTwice = await Effect.runPromise(Deferred.make<void>())
    const recover = Effect.gen(function* () {
      recoveryCalls += 1
      if (recoveryCalls === 2) {
        yield* Deferred.succeed(recoveredTwice, undefined)
      }
      return 0
    })

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          orphanRecoveryInterval: Duration.zero,
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(recoveredTwice).pipe(Effect.timeout("100 millis"))
        expect(recoveryCalls).toBeGreaterThanOrEqual(2)
      }),
      Layer.mergeAll(
        queueLayer(
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          recover,
        ),
        dbLayer(),
        Layer.succeed(IssueReconciler, { reconcile: unused }),
        keymaxxerLayer(),
      ),
    )
  })

  test("reconciles the Issue store and acknowledges after success", async () => {
    const jobs: RawJob[] = []
    let job: RawJob | undefined
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    const queue = queueLayer(jobs, (jobId) =>
      Deferred.succeed(acknowledged, jobId),
    )
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const github = Layer.succeed(GitHubService, {
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
        }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
      listReadyIssues: () =>
        Effect.succeed([
          {
            number: 57,
            title: "Execute queued Refresh Jobs in Harness",
            body: "Worker acceptance criteria",
            url: "https://github.com/acme/widgets/issues/57",
            createdAt: new Date("2026-07-14T00:00:00.000Z"),
            state: "OPEN" as const,
            parent: null,
            parentPosition: null,
            hasChildren: false,
            hierarchySupported: true,
            blockedBy: [],
            closingPullRequests: [],
          },
        ]),
    } satisfies GitHubServiceShape)
    const reconciler = IssueReconcilerLive.pipe(
      Layer.provideMerge(database),
      Layer.provideMerge(github),
    )
    const layer = Layer.mergeAll(database, reconciler, queue, keymaxxerLayer())

    await runScoped(
      Effect.gen(function* () {
        const db = yield* DbService
        const added = yield* db.addRepository({
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
          localPath: repository.localPath,
          isBare: true,
        })
        job = rawJob({
          _tag: "refresh-repository",
          repositoryId: RepositoryId.make(added.id),
        })
        jobs.push(job)

        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        expect(yield* Deferred.await(acknowledged)).toBe(job.jobId)
        const issues = yield* db.listIssues(added.id)
        expect(
          issues.map(({ githubIssueNumber }) => githubIssueNumber),
        ).toEqual([57])
      }),
      layer,
    )
  })

  test("marks malformed and unknown payloads terminal", async () => {
    for (const { payload, queue } of [
      {
        payload: { _tag: "refresh-repository", repositoryId: "invalid" },
        queue: ISSUE_REFRESH_QUEUE,
      },
      {
        payload: { _tag: "unknown-job", repositoryId: repository.id },
        queue: ISSUE_REFRESH_QUEUE,
      },
      {
        payload: { _tag: "unknown-job", stepRunId: "srun-bad" },
        queue: JOBS_QUEUE,
      },
    ]) {
      const job = rawJob(payload, queue)
      const failed = await Effect.runPromise(Deferred.make<string>())
      await runScoped(
        Effect.gen(function* () {
          yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          expect(yield* Deferred.await(failed)).toBe(job.jobId)
        }),
        Layer.mergeAll(
          queueLayer([job], undefined, (jobId) =>
            Deferred.succeed(failed, jobId),
          ),
          dbLayer(),
          Layer.succeed(IssueReconciler, { reconcile: unused }),
          keymaxxerLayer(),
        ),
      )
    }
  })

  test("publishes Issues-changed invalidation only after successful reconciliation", async () => {
    const successJob = rawJob(refreshPayload)
    const failureJob = rawJob(refreshPayload)
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    const failed = await Effect.runPromise(Deferred.make<string>())
    const notifications: string[] = []
    let calls = 0
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: () =>
        Effect.gen(function* () {
          calls += 1
          if (calls === 1) {
            return {
              fetched: 0,
              inserted: 0,
              updated: 0,
              deleted: 0,
              unchanged: 0,
            }
          }
          return yield* Effect.fail(
            new DatabaseError({ message: "reconciliation failed" }),
          )
        }),
    } satisfies IssueReconcilerShape)

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        expect(yield* Deferred.await(acknowledged)).toBe(successJob.jobId)
        expect(notifications).toEqual([repository.id])
        expect(yield* Deferred.await(failed)).toBe(failureJob.jobId)
        expect(notifications).toEqual([repository.id])
      }),
      Layer.mergeAll(
        queueLayer(
          [successJob, failureJob],
          (jobId) => Deferred.succeed(acknowledged, jobId),
          (jobId) => Deferred.succeed(failed, jobId),
        ),
        dbLayer([repository], (repositoryId) =>
          Effect.sync(() => {
            notifications.push(repositoryId)
          }),
        ),
        reconciler,
        keymaxxerLayer(),
      ),
    )
  })

  test("delivers only successful worker invalidations through GraphQL", async () => {
    const jobs: RawJob[] = []
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    const failed = await Effect.runPromise(Deferred.make<string>())
    let reconciliations = 0
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = queueLayer(
      jobs,
      (jobId) => Deferred.succeed(acknowledged, jobId),
      (jobId) => Deferred.succeed(failed, jobId),
    )
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: () =>
        Effect.gen(function* () {
          reconciliations += 1
          if (reconciliations === 2) {
            return yield* Effect.fail(
              new DatabaseError({ message: "reconciliation failed" }),
            )
          }
          return {
            fetched: 0,
            inserted: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          }
        }),
    } satisfies IssueReconcilerShape)
    const opencode = Layer.succeed(Opencode, {
      start: () => Effect.die("not used"),
      continue: () => Effect.die("not used"),
      listModels: () => Effect.die("not used"),
    })
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(database, queue, reconciler, keymaxxerLayer(), opencode),
    )
    const controller = new AbortController()

    try {
      const added = await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService
          return yield* db.addRepository({
            githubOwner: repository.githubOwner,
            githubRepo: repository.githubRepo,
            localPath: repository.localPath,
            isBare: true,
          })
        }),
      )
      const successJob = rawJob({
        _tag: "refresh-repository",
        repositoryId: RepositoryId.make(added.id),
      })
      const failureJob = rawJob({
        _tag: "refresh-repository",
        repositoryId: RepositoryId.make(added.id),
      })
      jobs.push(successJob, failureJob)

      const response = await createGraphqlApi(runtime).fetch(
        new Request("http://127.0.0.1:4200/graphql", {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: `subscription {
              issuesChanged(repositoryId: "${added.id}")
            }`,
          }),
          signal: controller.signal,
        }),
      )
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error("Subscription has no body")

      const invalidation = (async () => {
        let event = ""
        const decoder = new TextDecoder()
        while (!event.includes('"data":{"issuesChanged":true}')) {
          const next = await reader.read()
          if (next.done) {
            throw new Error("Subscription ended before invalidation")
          }
          event += decoder.decode(next.value, { stream: true })
        }
        return event
      })()
      await Bun.sleep(0)
      runtime.runFork(runJobWorker())

      expect(await runtime.runPromise(Deferred.await(acknowledged))).toBe(
        successJob.jobId,
      )
      expect(await invalidation).toContain('"data":{"issuesChanged":true}')

      expect(await runtime.runPromise(Deferred.await(failed))).toBe(
        failureJob.jobId,
      )
      const secondEvent = reader
        .read()
        .then(({ value }) =>
          value === undefined ? "" : new TextDecoder().decode(value),
        )
        .catch(() => "")
      const unexpectedInvalidation = await Promise.race([
        secondEvent.then((chunk) =>
          chunk.includes('"data":{"issuesChanged":true}'),
        ),
        Bun.sleep(20).then(() => false),
      ])
      expect(unexpectedInvalidation).toBe(false)
    } finally {
      controller.abort()
      await runtime.dispose()
    }
  })

  test("marks a caught Refresh Job failure terminal", async () => {
    const job = rawJob(refreshPayload)
    const failed = await Effect.runPromise(Deferred.make<string>())
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: () =>
        Effect.fail(new DatabaseError({ message: "reconciliation failed" })),
    } satisfies IssueReconcilerShape)

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        expect(yield* Deferred.await(failed)).toBe(job.jobId)
      }),
      Layer.mergeAll(
        queueLayer([job], undefined, (jobId) =>
          Deferred.succeed(failed, jobId),
        ),
        dbLayer(),
        reconciler,
        keymaxxerLayer(),
      ),
    )
  })

  test("executes duplicate Refresh Jobs serially across repositories", async () => {
    const jobs = [
      rawJob(refreshPayload),
      rawJob({
        _tag: "refresh-repository",
        repositoryId: RepositoryId.make(otherRepository.id),
      }),
    ]
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseFirst = await Effect.runPromise(Deferred.make<void>())
    const secondStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0
    let active = 0
    let maximumActive = 0
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: () =>
        Effect.gen(function* () {
          calls += 1
          active += 1
          maximumActive = Math.max(maximumActive, active)
          if (calls === 1) {
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
          } else {
            yield* Deferred.succeed(secondStarted, undefined)
          }
          active -= 1
          return {
            fetched: 0,
            inserted: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          }
        }),
    } satisfies IssueReconcilerShape)

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Deferred.await(firstStarted)
        expect(calls).toBe(1)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Deferred.await(secondStarted)
        expect(maximumActive).toBe(1)
      }),
      Layer.mergeAll(
        queueLayer(jobs),
        dbLayer([repository, otherRepository]),
        reconciler,
        keymaxxerLayer(),
      ),
    )
  })

  test("runs Work Item lifecycle jobs while Issue refresh is active", async () => {
    const refreshJob = rawJob(refreshPayload)
    const stepRunId = makeStepRunId()
    const lifecycleJob = rawJob(WorkItemStepJob.make({ stepRunId }), JOBS_QUEUE)
    const jobs = [refreshJob, lifecycleJob]
    const refreshStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseRefresh = await Effect.runPromise(Deferred.make<void>())
    const lifecycleDispatched = await Effect.runPromise(Deferred.make<string>())
    const lifecycleLeaseExtended = await Effect.runPromise(
      Deferred.make<string>(),
    )
    let refreshActiveDuringLifecycle = false

    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(refreshStarted, undefined)
          yield* Deferred.await(releaseRefresh)
          return {
            fetched: 0,
            inserted: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          }
        }),
    } satisfies IssueReconcilerShape)

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Deferred.await(refreshStarted)
        expect(yield* Deferred.await(lifecycleDispatched)).toBe(stepRunId)
        expect(refreshActiveDuringLifecycle).toBe(true)
        expect(yield* Deferred.await(lifecycleLeaseExtended)).toBe(
          lifecycleJob.jobId,
        )
        yield* Deferred.succeed(releaseRefresh, undefined)
      }),
      Layer.mergeAll(
        queueLayer(
          jobs,
          undefined,
          undefined,
          undefined,
          (receivedStepRunId) =>
            Effect.gen(function* () {
              refreshActiveDuringLifecycle = true
              yield* Deferred.succeed(lifecycleDispatched, receivedStepRunId)
              return { _tag: "noop" as const }
            }),
          (jobId) => Deferred.succeed(lifecycleLeaseExtended, jobId),
        ),
        dbLayer(),
        reconciler,
        keymaxxerLayer(),
      ),
    )
  })

  test("recovers after a queue infrastructure error", async () => {
    const job = rawJob(refreshPayload)
    const acknowledged = await Effect.runPromise(Deferred.make<void>())
    let refreshClaims = 0
    const claim = (queueName: string) => {
      if (queueName !== ISSUE_REFRESH_QUEUE) {
        return Effect.succeed(Option.none())
      }
      refreshClaims += 1
      return refreshClaims === 1
        ? Effect.fail(
            new ClaimError({
              queue: ISSUE_REFRESH_QUEUE,
              message: "temporarily down",
            }),
          )
        : Effect.succeed(refreshClaims === 2 ? Option.some(job) : Option.none())
    }

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Deferred.await(acknowledged)
        expect(refreshClaims).toBe(2)
      }),
      Layer.mergeAll(
        queueLayer(
          [],
          () => Deferred.succeed(acknowledged, undefined),
          undefined,
          claim,
        ),
        dbLayer(),
        Layer.succeed(IssueReconciler, {
          reconcile: () =>
            Effect.succeed({
              fetched: 0,
              inserted: 0,
              updated: 0,
              deleted: 0,
              unchanged: 0,
            }),
        }),
        keymaxxerLayer(),
      ),
    )
  })

  test("scope disposal interrupts an active Job without queue finalization", async () => {
    const job = rawJob(refreshPayload)
    const started = await Effect.runPromise(Deferred.make<void>())
    const interrupted = await Effect.runPromise(Deferred.make<void>())
    let finalized = false
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
          ),
        ),
    } satisfies IssueReconcilerShape)

    await runScoped(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* Deferred.await(started)
          }),
        )
        yield* Deferred.await(interrupted)
        expect(finalized).toBe(false)
      }),
      Layer.mergeAll(
        queueLayer(
          [job],
          () => Effect.sync(() => (finalized = true)),
          () => Effect.sync(() => (finalized = true)),
        ),
        dbLayer(),
        reconciler,
        keymaxxerLayer(),
      ),
    )
  })

  test("transfers persisted Refresh Jobs into the issue-refresh queue once", async () => {
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))
    const layer = Layer.mergeAll(database, queue)

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* QueueService
        const retainedId = yield* service.enqueue(
          JOBS_QUEUE,
          {
            _tag: "refresh-repository",
            repositoryId: RepositoryId.make(repository.id),
          },
          { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
        )
        const lifecycleId = yield* service.enqueue(
          JOBS_QUEUE,
          WorkItemStepJob.make({ stepRunId: makeStepRunId() }),
          { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
        )

        const moved = yield* transferPersistedRefreshJobs
        expect(moved).toBe(1)
        const movedAgain = yield* transferPersistedRefreshJobs
        expect(movedAgain).toBe(0)

        const fromLifecycle = yield* service.rawClaim(JOBS_QUEUE)
        expect(Option.isSome(fromLifecycle)).toBe(true)
        if (Option.isSome(fromLifecycle)) {
          expect(fromLifecycle.value.jobId).toBe(lifecycleId)
          expect(fromLifecycle.value.payload).toMatchObject({
            _tag: "work-item-step",
          })
        }

        const fromRefresh = yield* service.rawClaim(ISSUE_REFRESH_QUEUE)
        expect(Option.isSome(fromRefresh)).toBe(true)
        if (Option.isSome(fromRefresh)) {
          expect(fromRefresh.value.jobId).toBe(retainedId)
          expect(fromRefresh.value.payload).toEqual({
            _tag: "refresh-repository",
            repositoryId: repository.id,
          })
        }

        const noDuplicate = yield* service.rawClaim(ISSUE_REFRESH_QUEUE)
        expect(Option.isNone(noDuplicate)).toBe(true)
      }).pipe(Effect.provide(layer), Effect.orDie),
    )
  })

  test("checks high-priority Refresh Jobs before scheduled Issue polls", async () => {
    const claimOrder: string[] = []
    const repositoryOrder: string[] = []
    const manualJob = rawJob(refreshPayload, ISSUE_REFRESH_QUEUE)
    const scheduledJob = rawJob(
      {
        _tag: "refresh-repository",
        repositoryId: RepositoryId.make(otherRepository.id),
      },
      ISSUE_POLL_QUEUE,
      otherRepository.id,
    )
    const jobs = [scheduledJob, manualJob]
    const done = await Effect.runPromise(Deferred.make<void>())

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          samplePollingDelay: Effect.succeed(Duration.seconds(120)),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(done)
        expect(repositoryOrder).toEqual([repository.id, otherRepository.id])
        const refreshClaims = claimOrder.filter(
          (queueName) =>
            queueName === ISSUE_REFRESH_QUEUE || queueName === ISSUE_POLL_QUEUE,
        )
        expect(refreshClaims[0]).toBe(ISSUE_REFRESH_QUEUE)
        expect(refreshClaims).toContain(ISSUE_POLL_QUEUE)
      }),
      Layer.mergeAll(
        queueLayer(
          jobs,
          undefined,
          undefined,
          (queueName) =>
            Effect.sync(() => {
              claimOrder.push(queueName)
              const index = jobs.findIndex((job) => job.queue === queueName)
              if (index === -1) return Option.none()
              const [job] = jobs.splice(index, 1)
              return Option.some(job)
            }),
          undefined,
          undefined,
          undefined,
          () => Deferred.succeed(done, undefined),
        ),
        dbLayer([repository, otherRepository]),
        Layer.succeed(IssueReconciler, {
          reconcile: (repo) =>
            Effect.sync(() => {
              repositoryOrder.push(repo.id)
              return {
                fetched: 0,
                inserted: 0,
                updated: 0,
                deleted: 0,
                unchanged: 0,
              }
            }),
        }),
        keymaxxerLayer(),
      ),
    )
  })

  test("postpones a successful scheduled poll by the sampled cadence", async () => {
    const job = rawJob(refreshPayload, ISSUE_POLL_QUEUE, repository.id)
    const postponed = await Effect.runPromise(
      Deferred.make<{ jobId: string; delayMs: number }>(),
    )
    const notifications: string[] = []

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          samplePollingDelay: Effect.succeed(Duration.seconds(137)),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* Deferred.await(postponed)).toEqual({
          jobId: job.jobId,
          delayMs: 137_000,
        })
        expect(notifications).toEqual([repository.id])
      }),
      Layer.mergeAll(
        queueLayer(
          [job],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (jobId, delay) =>
            Deferred.succeed(postponed, {
              jobId,
              delayMs: Duration.toMillis(delay),
            }),
        ),
        dbLayer([repository], (repositoryId) =>
          Effect.sync(() => {
            notifications.push(repositoryId)
          }),
        ),
        Layer.succeed(IssueReconciler, {
          reconcile: () =>
            Effect.succeed({
              fetched: 0,
              inserted: 0,
              updated: 0,
              deleted: 0,
              unchanged: 0,
            }),
        }),
        keymaxxerLayer(),
      ),
    )
  })

  test("postpones a failed scheduled poll without publishing success", async () => {
    const job = rawJob(refreshPayload, ISSUE_POLL_QUEUE, repository.id)
    const postponed = await Effect.runPromise(Deferred.make<string>())
    const notifications: string[] = []
    let failed = false

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          samplePollingDelay: Effect.succeed(Duration.seconds(120)),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* Deferred.await(postponed)).toBe(job.jobId)
        expect(notifications).toEqual([])
        expect(failed).toBe(false)
      }),
      Layer.mergeAll(
        queueLayer(
          [job],
          undefined,
          () =>
            Effect.sync(() => {
              failed = true
            }),
          undefined,
          undefined,
          undefined,
          undefined,
          (jobId) => Deferred.succeed(postponed, jobId),
        ),
        dbLayer([repository], (repositoryId) =>
          Effect.sync(() => {
            notifications.push(repositoryId)
          }),
        ),
        Layer.succeed(IssueReconciler, {
          reconcile: () =>
            Effect.fail(new DatabaseError({ message: "scheduled fail" })),
        }),
        keymaxxerLayer(),
      ),
    )
  })

  test("finalizes a scheduled poll without recurrence when the Repository is missing", async () => {
    const job = rawJob(refreshPayload, ISSUE_POLL_QUEUE, repository.id)
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    let postponed = false

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          samplePollingDelay: Effect.succeed(Duration.seconds(120)),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* Deferred.await(acknowledged)).toBe(job.jobId)
        expect(postponed).toBe(false)
      }),
      Layer.mergeAll(
        queueLayer(
          [job],
          (jobId) => Deferred.succeed(acknowledged, jobId),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.sync(() => {
              postponed = true
            }),
        ),
        dbLayer([]),
        Layer.succeed(IssueReconciler, { reconcile: unused }),
        keymaxxerLayer(),
      ),
    )
  })

  test("finalizes a scheduled poll without recurrence when uncredentialed", async () => {
    const job = rawJob(refreshPayload, ISSUE_POLL_QUEUE, repository.id)
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    let postponed = false

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          samplePollingDelay: Effect.succeed(Duration.seconds(120)),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* Deferred.await(acknowledged)).toBe(job.jobId)
        expect(postponed).toBe(false)
      }),
      Layer.mergeAll(
        queueLayer(
          [job],
          (jobId) => Deferred.succeed(acknowledged, jobId),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.sync(() => {
              postponed = true
            }),
        ),
        dbLayer(),
        Layer.succeed(IssueReconciler, {
          reconcile: () =>
            Effect.fail(new DatabaseError({ message: "no credential" })),
        }),
        keymaxxerLayer(new Set()),
      ),
    )
  })

  test("does not alter a scheduled entry when a manual Refresh Job runs", async () => {
    const scheduledJob = rawJob(refreshPayload, ISSUE_POLL_QUEUE, repository.id)
    const manualJob = rawJob(refreshPayload)
    const jobs = [manualJob]
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    let postponed = false

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          samplePollingDelay: Effect.succeed(Duration.seconds(120)),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* Deferred.await(acknowledged)).toBe(manualJob.jobId)
        expect(postponed).toBe(false)
        expect(jobs).toEqual([])
        // Scheduled job remains unclaimed in its queue (not in the jobs list
        // because we only enqueued the manual job).
        expect(scheduledJob.queue).toBe(ISSUE_POLL_QUEUE)
      }),
      Layer.mergeAll(
        queueLayer(
          jobs,
          (jobId) => Deferred.succeed(acknowledged, jobId),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.sync(() => {
              postponed = true
            }),
        ),
        dbLayer(),
        Layer.succeed(IssueReconciler, {
          reconcile: () =>
            Effect.succeed({
              fetched: 0,
              inserted: 0,
              updated: 0,
              deleted: 0,
              unchanged: 0,
            }),
        }),
        keymaxxerLayer(),
      ),
    )
  })

  test("polls a Paused Repository on the scheduled cadence", async () => {
    const paused = makeRepositoryRecord({
      id: repository.id,
      paused: true,
    })
    const job = rawJob(refreshPayload, ISSUE_POLL_QUEUE, paused.id)
    const postponed = await Effect.runPromise(Deferred.make<string>())

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({
          idlePollInterval: Duration.zero,
          samplePollingDelay: Effect.succeed(Duration.seconds(125)),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* Deferred.await(postponed)).toBe(job.jobId)
      }),
      Layer.mergeAll(
        queueLayer(
          [job],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (jobId) => Deferred.succeed(postponed, jobId),
        ),
        dbLayer([paused]),
        Layer.succeed(IssueReconciler, {
          reconcile: (repo) =>
            Effect.sync(() => {
              expect(repo.paused).toBe(true)
              return {
                fetched: 0,
                inserted: 0,
                updated: 0,
                deleted: 0,
                unchanged: 0,
              }
            }),
        }),
        keymaxxerLayer(),
      ),
    )
  })

  test("persists a scheduled entry across worker restarts without replaying", async () => {
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))
    const reconciliations: string[] = []
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: (repo) =>
        Effect.sync(() => {
          reconciliations.push(repo.id)
          return {
            fetched: 0,
            inserted: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          }
        }),
    } satisfies IssueReconcilerShape)
    const lifecycle = Layer.succeed(WorkItemLifecycle, {
      maxDurations: {
        create_worktree: Duration.minutes(5),
        install_dependencies: Duration.minutes(15),
        implement: Duration.hours(2),
        pre_commit: Duration.hours(2),
        review: Duration.hours(1),
        commit: Duration.minutes(5),
        create_pr: Duration.minutes(10),
        watch_pr_status_checks: Duration.minutes(5),
        resolve_pr_merge_conflict: Duration.hours(2),
        investigate_pr_status_checks: Duration.hours(2),
        mark_pr_ready_for_review: Duration.minutes(5),
        decide_pr_merge: Duration.minutes(15),
        merge_pr: Duration.minutes(5),
        local_cleanup: Duration.minutes(5),
      },
      implementNow: unused,
      implementLocally: unused,
      recoverOrphanedStepRuns: Effect.succeed(0),
      runStep: () => Effect.succeed({ _tag: "noop" as const }),
      retry: unused,
      pause: unused,
      start: unused,
      abandon: unused,
      reset: unused,
      getWorkItem: unused,
      listWorkItemsForIssue: unused,
      listWorkItemsForRepository: unused,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const service = yield* QueueService
        const added = yield* db.addRepository({
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
          localPath: repository.localPath,
          isBare: true,
        })
        yield* service.ensureKeyed(
          ISSUE_POLL_QUEUE,
          added.id,
          {
            _tag: "refresh-repository",
            repositoryId: RepositoryId.make(added.id),
          },
          Duration.zero,
          { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* runJobWorker({
              idlePollInterval: Duration.zero,
              samplePollingDelay: Effect.succeed(Duration.seconds(120)),
            }).pipe(Effect.forkScoped({ startImmediately: true }))
            while (reconciliations.length < 1) {
              yield* Effect.sleep("5 millis")
            }
          }),
        )

        expect(reconciliations).toEqual([added.id])

        const keyed = yield* service.listKeyed(ISSUE_POLL_QUEUE)
        expect(keyed).toHaveLength(1)
        expect(keyed[0]?.key).toBe(added.id)
        expect(keyed[0]?.attempts).toBe(0)

        // Not immediately available again (postponed 120s).
        const claimNow = yield* service.rawClaim(ISSUE_POLL_QUEUE)
        expect(Option.isNone(claimNow)).toBe(true)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            queue,
            reconciler,
            keymaxxerLayer(),
            lifecycle,
          ),
        ),
        Effect.orDie,
      ),
    )
  })

  test("startup enqueues one Polling Auto-heal Job without awaiting repair", async () => {
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))
    const lifecycle = Layer.succeed(WorkItemLifecycle, {
      maxDurations: {
        create_worktree: Duration.minutes(5),
        install_dependencies: Duration.minutes(15),
        implement: Duration.hours(2),
        pre_commit: Duration.hours(2),
        review: Duration.hours(1),
        commit: Duration.minutes(5),
        create_pr: Duration.minutes(10),
        watch_pr_status_checks: Duration.minutes(5),
        resolve_pr_merge_conflict: Duration.hours(2),
        investigate_pr_status_checks: Duration.hours(2),
        mark_pr_ready_for_review: Duration.minutes(5),
        decide_pr_merge: Duration.minutes(15),
        merge_pr: Duration.minutes(5),
        local_cleanup: Duration.minutes(5),
      },
      implementNow: unused,
      implementLocally: unused,
      recoverOrphanedStepRuns: Effect.succeed(0),
      runStep: () => Effect.succeed({ _tag: "noop" as const }),
      retry: unused,
      pause: unused,
      start: unused,
      abandon: unused,
      reset: unused,
      getWorkItem: unused,
      listWorkItemsForIssue: unused,
      listWorkItemsForRepository: unused,
    })
    // Block Keymaxxer so auto-heal cannot finish during startup.
    const blockedKeymaxxer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.never,
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      removeSecret: () => Effect.die("not used"),
      runWithSecrets: () => Effect.die("not used"),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const service = yield* QueueService
        // Ensure auto-heal must consult Keymaxxer (and therefore blocks).
        yield* db.addRepository({
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
          localPath: repository.localPath,
          isBare: true,
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startJobWorker({
              idlePollInterval: Duration.zero,
              samplePollingDelay: Effect.succeed(Duration.seconds(120)),
            })
            // startJobWorker returns after durable enqueue + forking workers,
            // without waiting for auto-heal to finish (blocked on Keymaxxer).
            const autoHeal = yield* service.listKeyed(ISSUE_REFRESH_QUEUE)
            expect(autoHeal).toHaveLength(1)
            expect(autoHeal[0]?.key).toBe(POLLING_AUTO_HEAL_KEY)
            expect(autoHeal[0]?.payload).toEqual({
              _tag: "polling-auto-heal",
            })
            // Repair has not completed: no schedules yet.
            expect(yield* service.listKeyed(ISSUE_POLL_QUEUE)).toEqual([])
          }),
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            queue,
            Layer.succeed(IssueReconciler, {
              reconcile: () => Effect.die("not used"),
            }),
            blockedKeymaxxer,
            lifecycle,
          ),
        ),
        Effect.orDie,
      ),
    )
  })

  test("repeated startup scheduling does not create unbounded Auto-heal Jobs", async () => {
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* QueueService
        const first = yield* enqueuePollingAutoHealJob
        const second = yield* enqueuePollingAutoHealJob
        const third = yield* enqueuePollingAutoHealJob
        expect(first.created).toBe(true)
        expect(second.created).toBe(false)
        expect(third.created).toBe(false)
        expect(second.jobId).toBe(first.jobId)
        expect(third.jobId).toBe(first.jobId)
        const keyed = yield* service.listKeyed(ISSUE_REFRESH_QUEUE)
        expect(keyed).toHaveLength(1)
        expect(keyed[0]?.key).toBe(POLLING_AUTO_HEAL_KEY)
      }).pipe(Effect.provide(Layer.mergeAll(database, queue)), Effect.orDie),
    )
  })

  test("auto-heal repairs missing schedules, orphans, due times, and first refreshes", async () => {
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))
    const reconciliations: string[] = []
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: (repo) =>
        Effect.sync(() => {
          reconciliations.push(repo.id)
          return {
            fetched: 0,
            inserted: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          }
        }),
    } satisfies IssueReconcilerShape)
    const lifecycle = Layer.succeed(WorkItemLifecycle, {
      maxDurations: {
        create_worktree: Duration.minutes(5),
        install_dependencies: Duration.minutes(15),
        implement: Duration.hours(2),
        pre_commit: Duration.hours(2),
        review: Duration.hours(1),
        commit: Duration.minutes(5),
        create_pr: Duration.minutes(10),
        watch_pr_status_checks: Duration.minutes(5),
        resolve_pr_merge_conflict: Duration.hours(2),
        investigate_pr_status_checks: Duration.hours(2),
        mark_pr_ready_for_review: Duration.minutes(5),
        decide_pr_merge: Duration.minutes(15),
        merge_pr: Duration.minutes(5),
        local_cleanup: Duration.minutes(5),
      },
      implementNow: unused,
      implementLocally: unused,
      recoverOrphanedStepRuns: Effect.succeed(0),
      runStep: () => Effect.succeed({ _tag: "noop" as const }),
      retry: unused,
      pause: unused,
      start: unused,
      abandon: unused,
      reset: unused,
      getWorkItem: unused,
      listWorkItemsForIssue: unused,
      listWorkItemsForRepository: unused,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const service = yield* QueueService
        const credentialed = yield* db.addRepository({
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
          localPath: repository.localPath,
          isBare: true,
        })
        const uncredentialed = yield* db.addRepository({
          githubOwner: "other",
          githubRepo: "uncredentialed",
          localPath: "/repos/other/uncredentialed.git",
          isBare: true,
        })
        const preserved = yield* service.ensureKeyed(
          ISSUE_POLL_QUEUE,
          credentialed.id,
          {
            _tag: "refresh-repository",
            repositoryId: RepositoryId.make(credentialed.id),
          },
          Duration.millis(90_000),
          { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
        )
        const preservedBefore = yield* service.listKeyed(ISSUE_POLL_QUEUE)
        const preservedAvailableAt = DateTime.toEpochMillis(
          preservedBefore.find((entry) => entry.key === credentialed.id)!
            .availableAt,
        )
        yield* service.ensureKeyed(
          ISSUE_POLL_QUEUE,
          uncredentialed.id,
          {
            _tag: "refresh-repository",
            repositoryId: RepositoryId.make(uncredentialed.id),
          },
          Duration.seconds(30),
          { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
        )
        yield* service.ensureKeyed(
          ISSUE_POLL_QUEUE,
          "repo-deleted-orphan",
          {
            _tag: "refresh-repository",
            repositoryId: RepositoryId.make("repo-01J00000000000000000000099"),
          },
          Duration.seconds(30),
          { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
        )

        const missing = yield* db.addRepository({
          githubOwner: otherRepository.githubOwner,
          githubRepo: otherRepository.githubRepo,
          localPath: otherRepository.localPath,
          isBare: true,
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startJobWorker({
              idlePollInterval: Duration.zero,
              samplePollingDelay: Effect.succeed(Duration.seconds(142)),
            })
            // Wait until auto-heal finishes and the missing repo's first refresh runs.
            while (
              !(
                reconciliations.includes(missing.id) &&
                (yield* service.listKeyed(ISSUE_REFRESH_QUEUE)).every(
                  (entry) => entry.key !== POLLING_AUTO_HEAL_KEY,
                )
              )
            ) {
              yield* Effect.sleep("5 millis")
            }
          }),
        )

        const schedules = yield* service.listKeyed(ISSUE_POLL_QUEUE)
        expect(schedules.map((entry) => entry.key).sort()).toEqual(
          [credentialed.id, missing.id].sort(),
        )
        const preservedEntry = schedules.find(
          (entry) => entry.key === credentialed.id,
        )
        expect(preservedEntry?.jobId).toBe(preserved.jobId)
        expect(
          Math.abs(
            DateTime.toEpochMillis(preservedEntry!.availableAt) -
              preservedAvailableAt,
          ),
        ).toBeLessThan(2_000)

        const missingEntry = schedules.find((entry) => entry.key === missing.id)
        expect(missingEntry).toBeDefined()
        expect(
          DateTime.toEpochMillis(missingEntry!.availableAt) - Date.now(),
        ).toBeGreaterThan(100_000)

        // Manual first refresh for the repaired Repository was accepted and run.
        expect(reconciliations).toContain(missing.id)
        // Existing correct schedule was not reset into an immediate poll.
        expect(reconciliations).not.toContain(credentialed.id)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            queue,
            reconciler,
            keymaxxerLayer(
              new Set([
                `${repository.githubOwner}/${repository.githubRepo}`,
                `${otherRepository.githubOwner}/${otherRepository.githubRepo}`,
              ]),
            ),
            lifecycle,
          ),
        ),
        Effect.orDie,
      ),
    )
  })

  test("auto-heal retries with backoff until Keymaxxer succeeds", async () => {
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))
    let findSecretCalls = 0
    const keymaxxer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: ({ account, provider }) =>
        Effect.gen(function* () {
          findSecretCalls += 1
          if (findSecretCalls < 3) {
            return yield* Effect.fail(
              new KeymaxxerError({
                operation: "findSecret",
                message: "Keymaxxer unavailable",
              }),
            )
          }
          return provider === "github" &&
            account === `${repository.githubOwner}/${repository.githubRepo}`
            ? `GITHUB_TOKEN`
            : null
        }),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      removeSecret: () => Effect.die("not used"),
      runWithSecrets: () => Effect.die("not used"),
    })
    const lifecycle = Layer.succeed(WorkItemLifecycle, {
      maxDurations: {
        create_worktree: Duration.minutes(5),
        install_dependencies: Duration.minutes(15),
        implement: Duration.hours(2),
        pre_commit: Duration.hours(2),
        review: Duration.hours(1),
        commit: Duration.minutes(5),
        create_pr: Duration.minutes(10),
        watch_pr_status_checks: Duration.minutes(5),
        resolve_pr_merge_conflict: Duration.hours(2),
        investigate_pr_status_checks: Duration.hours(2),
        mark_pr_ready_for_review: Duration.minutes(5),
        decide_pr_merge: Duration.minutes(15),
        merge_pr: Duration.minutes(5),
        local_cleanup: Duration.minutes(5),
      },
      implementNow: unused,
      implementLocally: unused,
      recoverOrphanedStepRuns: Effect.succeed(0),
      runStep: () => Effect.succeed({ _tag: "noop" as const }),
      retry: unused,
      pause: unused,
      start: unused,
      abandon: unused,
      reset: unused,
      getWorkItem: unused,
      listWorkItemsForIssue: unused,
      listWorkItemsForRepository: unused,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const service = yield* QueueService
        const added = yield* db.addRepository({
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
          localPath: repository.localPath,
          isBare: true,
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startJobWorker({
              idlePollInterval: Duration.zero,
              samplePollingDelay: Effect.succeed(Duration.seconds(120)),
              sampleAutoHealBackoff: Effect.succeed(Duration.zero),
            })
            while ((yield* service.listKeyed(ISSUE_POLL_QUEUE)).length < 1) {
              yield* Effect.sleep("5 millis")
            }
          }),
        )

        const schedules = yield* service.listKeyed(ISSUE_POLL_QUEUE)
        expect(schedules).toHaveLength(1)
        expect(schedules[0]?.key).toBe(added.id)
        expect(findSecretCalls).toBeGreaterThanOrEqual(3)
        const autoHeal = yield* service.listKeyed(ISSUE_REFRESH_QUEUE)
        expect(
          autoHeal.filter((entry) => entry.key === POLLING_AUTO_HEAL_KEY),
        ).toHaveLength(0)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            queue,
            Layer.succeed(IssueReconciler, {
              reconcile: () =>
                Effect.succeed({
                  fetched: 0,
                  inserted: 0,
                  updated: 0,
                  deleted: 0,
                  unchanged: 0,
                }),
            }),
            keymaxxer,
            lifecycle,
          ),
        ),
        Effect.orDie,
      ),
    )
  })

  test("successful auto-heal does not disturb queued manual Refresh Jobs", async () => {
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))
    const reconciliations: string[] = []
    const reconciler = Layer.succeed(IssueReconciler, {
      reconcile: (repo) =>
        Effect.sync(() => {
          reconciliations.push(repo.id)
          return {
            fetched: 0,
            inserted: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
          }
        }),
    } satisfies IssueReconcilerShape)
    const lifecycle = Layer.succeed(WorkItemLifecycle, {
      maxDurations: {
        create_worktree: Duration.minutes(5),
        install_dependencies: Duration.minutes(15),
        implement: Duration.hours(2),
        pre_commit: Duration.hours(2),
        review: Duration.hours(1),
        commit: Duration.minutes(5),
        create_pr: Duration.minutes(10),
        watch_pr_status_checks: Duration.minutes(5),
        resolve_pr_merge_conflict: Duration.hours(2),
        investigate_pr_status_checks: Duration.hours(2),
        mark_pr_ready_for_review: Duration.minutes(5),
        decide_pr_merge: Duration.minutes(15),
        merge_pr: Duration.minutes(5),
        local_cleanup: Duration.minutes(5),
      },
      implementNow: unused,
      implementLocally: unused,
      recoverOrphanedStepRuns: Effect.succeed(0),
      runStep: () => Effect.succeed({ _tag: "noop" as const }),
      retry: unused,
      pause: unused,
      start: unused,
      abandon: unused,
      reset: unused,
      getWorkItem: unused,
      listWorkItemsForIssue: unused,
      listWorkItemsForRepository: unused,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const service = yield* QueueService
        const added = yield* db.addRepository({
          githubOwner: repository.githubOwner,
          githubRepo: repository.githubRepo,
          localPath: repository.localPath,
          isBare: true,
        })
        const manualId = yield* service.enqueue(
          ISSUE_REFRESH_QUEUE,
          {
            _tag: "refresh-repository",
            repositoryId: RepositoryId.make(added.id),
          },
          { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startJobWorker({
              idlePollInterval: Duration.zero,
              samplePollingDelay: Effect.succeed(Duration.seconds(120)),
            })
            while (!reconciliations.includes(added.id)) {
              yield* Effect.sleep("5 millis")
            }
            // Allow the worker to drain high-priority work.
            yield* Effect.sleep("50 millis")
          }),
        )

        expect(
          reconciliations.filter((id) => id === added.id).length,
        ).toBeGreaterThanOrEqual(1)
        // Manual job identity was accepted before auto-heal; after drain it is gone.
        const remaining = yield* service.rawClaim(ISSUE_REFRESH_QUEUE)
        expect(Option.isNone(remaining)).toBe(true)
        // The schedule exists and auto-heal is finalized.
        const schedules = yield* service.listKeyed(ISSUE_POLL_QUEUE)
        expect(schedules.map((entry) => entry.key)).toEqual([added.id])
        const autoHeal = yield* service.listKeyed(ISSUE_REFRESH_QUEUE)
        expect(
          autoHeal.filter((entry) => entry.key === POLLING_AUTO_HEAL_KEY),
        ).toHaveLength(0)
        void manualId
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            queue,
            reconciler,
            keymaxxerLayer(),
            lifecycle,
          ),
        ),
        Effect.orDie,
      ),
    )
  })
})
