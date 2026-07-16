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
import {
  ISSUE_POLL_QUEUE,
  ISSUE_REFRESH_QUEUE,
  JOB_RECOVERY_RETRY_LIMIT,
  sampleIssuePollingDelay,
} from "@ready-for-agent/graphql-api"
import { IssueReconciler } from "@ready-for-agent/issue-reconciler"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { QueueService } from "@ready-for-agent/queue-service"
import {
  WorkItemLifecycle,
  WorkItemStepJob,
} from "@ready-for-agent/work-item-lifecycle"

/** Work Item lifecycle queue (unchanged). */
export const JOBS_QUEUE = "jobs"
export { ISSUE_POLL_QUEUE, ISSUE_REFRESH_QUEUE, JOB_RECOVERY_RETRY_LIMIT }
export const JOB_VISIBILITY_TIMEOUT = Duration.minutes(5)
const LIFECYCLE_JOB_VISIBILITY_GRACE = Duration.minutes(1)
const JOB_IDLE_POLL_INTERVAL = Duration.millis(1500)
const ORPHAN_RECOVERY_INTERVAL = Duration.seconds(30)
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

const repositoryHasGitHubCredential = (
  githubOwner: string,
  githubRepo: string,
) =>
  Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    const credential = yield* keymaxxer.findSecret({
      provider: "github",
      account: `${githubOwner}/${githubRepo}`,
    })
    return credential !== null
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
  /** Override cadence sampling for deterministic tests. */
  readonly samplePollingDelay?: Effect.Effect<Duration.Duration>
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

const claimRefreshJob = (
  queueName: string,
  visibilityTimeout: Duration.Duration,
) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    return yield* QueueService.claim(
      queueName,
      RefreshRepositoryJob,
      visibilityTimeout,
    ).pipe(
      Effect.catchTag("PayloadParseError", (error) =>
        queue
          .fail(error.jobId, { retryable: false })
          .pipe(Effect.as(Option.none())),
      ),
    )
  })

type AttemptResult =
  | { readonly _tag: "Failure"; readonly failure: unknown }
  | { readonly _tag: "Success"; readonly success: unknown }

const finalizeManualRefresh = (
  jobId: string,
  result: AttemptResult,
  repositoryId: RepositoryId,
) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    if (result._tag === "Failure") {
      yield* Effect.logError("Refresh Job failed", {
        jobId,
        repositoryId,
        error: formatLogError(result.failure),
      })
      yield* queue.fail(jobId, { retryable: false })
    } else {
      yield* queue.acknowledge(jobId)
    }
  })

const finalizeScheduledRefresh = (
  jobId: string,
  repositoryId: RepositoryId,
  result: AttemptResult,
  sampleDelay: Effect.Effect<Duration.Duration>,
) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(({ id }) => id === repositoryId)

    if (repository === undefined) {
      yield* Effect.logWarning(
        "Scheduled Issue poll finalized without recurrence; Repository missing",
        { jobId, repositoryId },
      )
      yield* queue.acknowledge(jobId)
      return
    }

    const credentialed = yield* repositoryHasGitHubCredential(
      repository.githubOwner,
      repository.githubRepo,
    )
    if (!credentialed) {
      yield* Effect.logWarning(
        "Scheduled Issue poll finalized without recurrence; Repository uncredentialed",
        { jobId, repositoryId },
      )
      yield* queue.acknowledge(jobId)
      return
    }

    if (result._tag === "Failure") {
      yield* Effect.logError("Scheduled Issue poll failed", {
        jobId,
        repositoryId,
        error: formatLogError(result.failure),
      })
    }

    const delay = yield* sampleDelay
    yield* queue.postponeKeyed(jobId, delay)
  })

/**
 * One dedicated polling worker: always claim high-priority manual work before
 * scheduled recurring entries. Never interrupts a running reconciliation.
 */
const claimAndRunRefreshJob = (
  visibilityTimeout: Duration.Duration,
  sampleDelay: Effect.Effect<Duration.Duration>,
) =>
  Effect.gen(function* () {
    const highPriority = yield* claimRefreshJob(
      ISSUE_REFRESH_QUEUE,
      visibilityTimeout,
    )
    if (Option.isSome(highPriority)) {
      const job = highPriority.value
      const result = yield* Effect.result(
        refreshRepository(job.payload.repositoryId),
      )
      yield* finalizeManualRefresh(job.jobId, result, job.payload.repositoryId)
      return "busy" as const
    }

    const scheduled = yield* claimRefreshJob(
      ISSUE_POLL_QUEUE,
      visibilityTimeout,
    )
    if (Option.isNone(scheduled)) return "idle" as const

    const job = scheduled.value
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === job.payload.repositoryId,
    )
    if (repository === undefined) {
      yield* finalizeScheduledRefresh(
        job.jobId,
        job.payload.repositoryId,
        {
          _tag: "Failure",
          failure: new RepositoryNotFoundError({
            repositoryId: job.payload.repositoryId,
          }),
        },
        sampleDelay,
      )
      return "busy" as const
    }

    const credentialed = yield* repositoryHasGitHubCredential(
      repository.githubOwner,
      repository.githubRepo,
    )
    if (!credentialed) {
      yield* finalizeScheduledRefresh(
        job.jobId,
        job.payload.repositoryId,
        { _tag: "Failure", failure: "Repository uncredentialed" },
        sampleDelay,
      )
      return "busy" as const
    }

    const result = yield* Effect.result(
      refreshRepository(job.payload.repositoryId),
    )
    yield* finalizeScheduledRefresh(
      job.jobId,
      job.payload.repositoryId,
      result,
      sampleDelay,
    )
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
 * Host lifecycle and Issue polling workers as independent fibers that share one
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
    const sampleDelay = options.samplePollingDelay ?? sampleIssuePollingDelay

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
          claimAndRunRefreshJob(visibilityTimeout, sampleDelay),
          "Issue polling job queue",
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
