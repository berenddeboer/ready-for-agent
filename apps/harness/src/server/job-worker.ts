import "@tanstack/react-start/server-only"
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect"
import {
  DbService,
  RepositoryId,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import { IssueReconciler } from "@ready-for-agent/issue-reconciler"
import { QueueService } from "@ready-for-agent/queue-service"
import {
  WorkItemLifecycle,
  WorkItemStepJob,
} from "@ready-for-agent/work-item-lifecycle"

/** Work Item lifecycle queue (unchanged). */
export const JOBS_QUEUE = "jobs"
/** High-priority manual Issue Refresh Job queue. */
export const ISSUE_REFRESH_QUEUE = "issue-refresh"
export const JOB_VISIBILITY_TIMEOUT = Duration.minutes(5)
const LIFECYCLE_JOB_VISIBILITY_GRACE = Duration.minutes(1)
const JOB_IDLE_POLL_INTERVAL = Duration.millis(1500)
const ORPHAN_RECOVERY_INTERVAL = Duration.seconds(30)
export const JOB_RECOVERY_RETRY_LIMIT = 1
const REFRESH_REPOSITORY_TAG = "refresh-repository"

/**
 * Process-global generation so HMR/runtime restarts retire zombie workers that
 * would otherwise keep claiming jobs while GraphQL listens on a new runtime.
 */
const workerGenerationKey = Symbol.for(
  "@ready-for-agent/harness/job-worker-generation",
)

const nextWorkerGeneration = (): number => {
  const globalState = globalThis as typeof globalThis & {
    [workerGenerationKey]?: number
  }
  const next = (globalState[workerGenerationKey] ?? 0) + 1
  globalState[workerGenerationKey] = next
  return next
}

const currentWorkerGeneration = (): number => {
  const globalState = globalThis as typeof globalThis & {
    [workerGenerationKey]?: number
  }
  return globalState[workerGenerationKey] ?? 0
}

const formatLogError = (error: unknown): string => {
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim()
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string" &&
    (error as { message: string }).message.trim().length > 0
  ) {
    return (error as { message: string }).message.trim()
  }
  return String(error)
}

const RefreshRepositoryJob = Schema.TaggedStruct("refresh-repository", {
  repositoryId: RepositoryId,
})

export const enqueueRefreshRepositoryJob = (repositoryId: RepositoryId) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const payload = yield* Schema.decodeUnknownEffect(RefreshRepositoryJob)({
      _tag: "refresh-repository",
      repositoryId,
    })
    return yield* queue.enqueue(ISSUE_REFRESH_QUEUE, payload, {
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
  })

/** Move pre-split Refresh Jobs off the lifecycle queue into the polling lane. */
export const transferPersistedRefreshJobs = Effect.gen(function* () {
  const queue = yield* QueueService
  return yield* queue.requeueByPayloadTag(
    JOBS_QUEUE,
    ISSUE_REFRESH_QUEUE,
    REFRESH_REPOSITORY_TAG,
  )
})

const refreshRepository = (repositoryId: RepositoryId) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const reconciler = yield* IssueReconciler
    const repositories = yield* db.listRepositories
    const repository = repositories.find(({ id }) => id === repositoryId)

    if (repository === undefined) {
      return yield* new RepositoryNotFoundError({ repositoryId })
    }

    const summary = yield* reconciler.reconcile(repository)
    yield* db.notifyIssuesChanged(repositoryId)
    return summary
  })

export interface JobWorkerOptions {
  readonly idlePollInterval?: Duration.Duration
  readonly visibilityTimeout?: Duration.Duration
  readonly orphanRecoveryInterval?: Duration.Duration
}

const runQueuePollLoop = <E, R>(
  generation: number,
  idlePollInterval: Duration.Duration,
  claimAndRun: Effect.Effect<"idle" | "busy", E, R>,
  logLabel: string,
) =>
  Effect.gen(function* () {
    const sleepIdle = yield* Schedule.toStepWithSleep(
      Schedule.spaced(idlePollInterval).pipe(Schedule.jittered),
    )

    while (generation === currentWorkerGeneration()) {
      const state = yield* claimAndRun.pipe(
        Effect.catch((error) =>
          Effect.logError(`${logLabel} poll failed`, {
            error: formatLogError(error),
          }).pipe(Effect.as("idle" as const)),
        ),
      )
      if (state === "idle") {
        yield* sleepIdle(undefined).pipe(Effect.asVoid)
      }
    }
  })

const claimAndRunRefreshJob = (visibilityTimeout: Duration.Duration) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const claimed = yield* QueueService.claim(
      ISSUE_REFRESH_QUEUE,
      RefreshRepositoryJob,
      visibilityTimeout,
    ).pipe(
      Effect.catchTag("PayloadParseError", (error) =>
        queue
          .fail(error.jobId, { retryable: false })
          .pipe(Effect.as(Option.none())),
      ),
    )

    if (Option.isNone(claimed)) return "idle" as const

    const job = claimed.value
    const result = yield* Effect.result(
      refreshRepository(job.payload.repositoryId),
    )

    if (result._tag === "Failure") {
      yield* Effect.logError("Refresh Job failed", {
        jobId: job.jobId,
        repositoryId: job.payload.repositoryId,
        error: formatLogError(result.failure),
      })
      yield* queue.fail(job.jobId, { retryable: false })
    } else {
      yield* queue.acknowledge(job.jobId)
    }

    return "busy" as const
  })

const claimAndRunLifecycleJob = (
  visibilityTimeout: Duration.Duration,
  orphanRecoveryInterval: Duration.Duration,
) => {
  let nextOrphanRecoveryAt = 0

  return Effect.gen(function* () {
    const queue = yield* QueueService
    const lifecycle = yield* WorkItemLifecycle
    const lifecycleJobVisibilityTimeout = Duration.millis(
      Math.max(
        ...Object.values(lifecycle.maxDurations).map(Duration.toMillis),
      ) + Duration.toMillis(LIFECYCLE_JOB_VISIBILITY_GRACE),
    )

    const now = yield* Clock.currentTimeMillis
    if (now >= nextOrphanRecoveryAt) {
      yield* lifecycle.recoverOrphanedStepRuns
      nextOrphanRecoveryAt = now + Duration.toMillis(orphanRecoveryInterval)
    }

    const claimed = yield* QueueService.claim(
      JOBS_QUEUE,
      WorkItemStepJob,
      visibilityTimeout,
    ).pipe(
      Effect.catchTag("PayloadParseError", (error) =>
        queue
          .fail(error.jobId, { retryable: false })
          .pipe(Effect.as(Option.none())),
      ),
    )

    if (Option.isNone(claimed)) return "idle" as const

    const job = claimed.value
    yield* queue.extendVisibility(job.jobId, lifecycleJobVisibilityTimeout)
    const result = yield* Effect.result(
      lifecycle.runStep(job.payload.stepRunId),
    )

    if (result._tag === "Failure") {
      yield* Effect.logError("Work Item Lifecycle Job failed", {
        jobId: job.jobId,
        stepRunId: job.payload.stepRunId,
        error: formatLogError(result.failure),
      })
    }

    return "busy" as const
  })
}

/**
 * Host lifecycle and Issue Refresh workers as independent fibers that share one
 * generation token so HMR retires both together.
 */
export const runJobWorker = (options: JobWorkerOptions = {}) =>
  Effect.gen(function* () {
    const generation = nextWorkerGeneration()
    const idlePollInterval = options.idlePollInterval ?? JOB_IDLE_POLL_INTERVAL
    const visibilityTimeout =
      options.visibilityTimeout ?? JOB_VISIBILITY_TIMEOUT
    const orphanRecoveryInterval =
      options.orphanRecoveryInterval ?? ORPHAN_RECOVERY_INTERVAL

    yield* Effect.all(
      [
        runQueuePollLoop(
          generation,
          idlePollInterval,
          claimAndRunLifecycleJob(visibilityTimeout, orphanRecoveryInterval),
          "Lifecycle job queue",
        ),
        runQueuePollLoop(
          generation,
          idlePollInterval,
          claimAndRunRefreshJob(visibilityTimeout),
          "Issue refresh job queue",
        ),
      ],
      { concurrency: "unbounded", discard: true },
    )
  })

export const JobWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* transferPersistedRefreshJobs
    yield* runJobWorker().pipe(Effect.forkScoped({ startImmediately: true }))
  }),
)
