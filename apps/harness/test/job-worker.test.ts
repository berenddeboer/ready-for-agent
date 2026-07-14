import { DateTime, Deferred, Duration, Effect, Layer, Option } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DatabaseError,
  DbService,
  DbServiceLive,
  RepositoryId,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  IssueReconciler,
  IssueReconcilerLive,
  type IssueReconcilerShape,
} from "@ready-for-agent/issue-reconciler"
import {
  ClaimError,
  QueueService,
  type QueueServiceShape,
  type RawJob,
  makeJobId,
} from "@ready-for-agent/queue-service"
import {
  JOBS_QUEUE,
  JOB_RECOVERY_RETRY_LIMIT,
  JOB_VISIBILITY_TIMEOUT,
  enqueueRefreshRepositoryJob,
  runJobWorker,
} from "../src/server/job-worker.js"
import { describe, expect, test } from "bun:test"

const repository: RepositoryRecord = {
  id: "repo-01J00000000000000000000000",
  githubOwner: "acme",
  githubRepo: "widgets",
  localPath: "/repos/acme/widgets",
  isBare: true,
  paused: true,
  issuesReconciledAt: null,
}

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

const dbLayer = (repositories: readonly RepositoryRecord[] = [repository]) =>
  Layer.succeed(DbService, {
    repositoryChanges: Effect.die("not used") as never,
    getConfig: unused(),
    updateConfig: unused,
    addRepository: unused,
    listRepositories: Effect.succeed(repositories),
    removeRepository: unused,
    storeIssue: unused,
    listIssues: unused,
    deleteIssue: unused,
    markIssuesReconciled: unused,
  })

const queueLayer = (
  jobs: RawJob[],
  onAcknowledge: (jobId: string) => Effect.Effect<unknown> = () => Effect.void,
  onFail: (jobId: string) => Effect.Effect<unknown> = () => Effect.void,
  onClaim?: () => Effect.Effect<Option.Option<RawJob>, ClaimError>,
) =>
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
  } satisfies QueueServiceShape)

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

  test("reconciles the Issue store and acknowledges after success", async () => {
    const jobs: RawJob[] = []
    let job: RawJob | undefined
    const acknowledged = await Effect.runPromise(Deferred.make<string>())
    const queue = queueLayer(jobs, (jobId) =>
      Deferred.succeed(acknowledged, jobId),
    )
    const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    const github = Layer.succeed(GitHubService, {
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
