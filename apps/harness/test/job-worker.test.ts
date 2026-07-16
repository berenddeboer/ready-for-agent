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
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import {
  ClaimError,
  QueueService,
  type QueueServiceShape,
  type RawJob,
  makeJobId,
} from "@ready-for-agent/queue-service"
import {
  WorkItemLifecycle,
  WorkItemStepJob,
  makeStepRunId,
} from "@ready-for-agent/work-item-lifecycle"
import {
  JOBS_QUEUE,
  JOB_RECOVERY_RETRY_LIMIT,
  JOB_VISIBILITY_TIMEOUT,
  enqueueRefreshRepositoryJob,
  runJobWorker,
} from "../src/server/job-worker.js"
import { describe, expect, test } from "bun:test"

const repository = makeRepositoryRecord({
  id: "repo-01J00000000000000000000000",
  paused: true,
})

const refreshPayload = {
  _tag: "refresh-repository" as const,
  repositoryId: RepositoryId.make(repository.id),
}

const rawJob = (payload: unknown): RawJob => {
  const now = DateTime.makeUnsafe(0)
  return {
    jobId: makeJobId(),
    queue: JOBS_QUEUE,
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

const queueLayer = (
  jobs: RawJob[],
  onAcknowledge: (jobId: string) => Effect.Effect<unknown> = () => Effect.void,
  onFail: (jobId: string) => Effect.Effect<unknown> = () => Effect.void,
  onClaim?: () => Effect.Effect<Option.Option<RawJob>, ClaimError>,
  runStep: (
    stepRunId: string,
  ) => Effect.Effect<{ readonly _tag: "noop" }> = () =>
    Effect.succeed({ _tag: "noop" as const }),
) =>
  Layer.merge(
    Layer.succeed(QueueService, {
      queueInTransaction: true,
      enqueue: unused,
      enqueueWithDelay: unused,
      rawClaim: (_queue, visibilityTimeout) =>
        Effect.gen(function* () {
          expect(Duration.toMillis(visibilityTimeout ?? Duration.zero)).toBe(
            Duration.toMillis(JOB_VISIBILITY_TIMEOUT),
          )
          if (onClaim !== undefined) return yield* onClaim()
          return Option.fromNullishOr(jobs.shift())
        }),
      acknowledge: (jobId) => onAcknowledge(jobId).pipe(Effect.asVoid),
      fail: (jobId, options) =>
        Effect.gen(function* () {
          expect(options?.retryable).toBe(false)
          yield* onFail(jobId)
        }),
      extendVisibility: unused,
      getStats: unused,
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
      },
      implementNow: unused,
      runStep,
      retry: unused,
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
  test("enqueues a validated Refresh Job with one recovery claim", async () => {
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
      rawClaim: unused,
      acknowledge: unused,
      fail: unused,
      extendVisibility: unused,
      getStats: unused,
    } satisfies QueueServiceShape)

    await Effect.runPromise(
      enqueueRefreshRepositoryJob(refreshPayload.repositoryId).pipe(
        Effect.provide(queue),
      ),
    )

    expect(enqueued).toEqual({
      queue: JOBS_QUEUE,
      payload: refreshPayload,
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
  })

  test("dispatches a Work Item Lifecycle Job and acknowledges a stale no-op", async () => {
    const stepRunId = makeStepRunId()
    const payload = WorkItemStepJob.make({ stepRunId })
    const job = rawJob(payload)
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    const dispatched = await Effect.runPromise(Deferred.make<string>())

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        expect(yield* Deferred.await(dispatched)).toBe(stepRunId)
        expect(yield* Deferred.await(acknowledged)).toBe(job.jobId)
      }),
      Layer.merge(
        queueLayer(
          [job],
          (jobId) => Deferred.succeed(acknowledged, jobId),
          undefined,
          undefined,
          (receivedStepRunId) =>
            Deferred.succeed(dispatched, receivedStepRunId).pipe(
              Effect.as({ _tag: "noop" as const }),
            ),
        ),
        Layer.merge(
          dbLayer(),
          Layer.succeed(IssueReconciler, { reconcile: unused }),
        ),
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
    const layer = Layer.mergeAll(database, reconciler, queue)

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
    for (const payload of [
      { _tag: "refresh-repository", repositoryId: "invalid" },
      { _tag: "unknown-job", repositoryId: repository.id },
    ]) {
      const job = rawJob(payload)
      const failed = await Effect.runPromise(Deferred.make<string>())
      await runScoped(
        Effect.gen(function* () {
          yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          expect(yield* Deferred.await(failed)).toBe(job.jobId)
        }),
        Layer.merge(
          queueLayer([job], undefined, (jobId) =>
            Deferred.succeed(failed, jobId),
          ),
          Layer.merge(
            dbLayer(),
            Layer.succeed(IssueReconciler, { reconcile: unused }),
          ),
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
    const keymaxxer = Layer.succeed(KeymaxxerService, {
      initialize: Effect.void,
      findSecret: () => Effect.die("not used"),
      findSecrets: () => Effect.die("not used"),
      hasSecret: () => Effect.die("not used"),
      addSecret: () => Effect.die("not used"),
      removeSecret: () => Effect.die("not used"),
      runWithSecrets: () => Effect.die("not used"),
    })
    const opencode = Layer.succeed(Opencode, {
      start: () => Effect.die("not used"),
      continue: () => Effect.die("not used"),
      listModels: () => Effect.die("not used"),
    })
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(database, queue, reconciler, keymaxxer, opencode),
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
      ),
    )
  })

  test("executes duplicate Refresh Jobs serially", async () => {
    const jobs = [rawJob(refreshPayload), rawJob(refreshPayload)]
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
      Layer.mergeAll(queueLayer(jobs), dbLayer(), reconciler),
    )
  })

  test("recovers after a queue infrastructure error", async () => {
    const job = rawJob(refreshPayload)
    const acknowledged = await Effect.runPromise(Deferred.make<void>())
    let claims = 0
    const claim = () => {
      claims += 1
      return claims === 1
        ? Effect.fail(
            new ClaimError({ queue: JOBS_QUEUE, message: "temporarily down" }),
          )
        : Effect.succeed(claims === 2 ? Option.some(job) : Option.none())
    }

    await runScoped(
      Effect.gen(function* () {
        yield* runJobWorker({ idlePollInterval: Duration.zero }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Deferred.await(acknowledged)
        expect(claims).toBe(2)
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
      ),
    )
  })
})
