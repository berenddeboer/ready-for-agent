import "@tanstack/react-start/server-only"
import { Duration, Effect, Layer, Option, Schema } from "effect"
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

export const JOBS_QUEUE = "jobs"
export const JOB_VISIBILITY_TIMEOUT = Duration.minutes(5)
const JOB_IDLE_POLL_INTERVAL = Duration.seconds(1)
export const JOB_RECOVERY_RETRY_LIMIT = 1

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

const JobPayload = Schema.Union([RefreshRepositoryJob, WorkItemStepJob])

export const enqueueRefreshRepositoryJob = (repositoryId: RepositoryId) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const payload = yield* Schema.decodeUnknownEffect(RefreshRepositoryJob)({
      _tag: "refresh-repository",
      repositoryId,
    })
    return yield* queue.enqueue(JOBS_QUEUE, payload, {
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
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
}

export const runJobWorker = (options: JobWorkerOptions = {}) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const idlePollInterval = options.idlePollInterval ?? JOB_IDLE_POLL_INTERVAL
    const visibilityTimeout =
      options.visibilityTimeout ?? JOB_VISIBILITY_TIMEOUT

    const claimAndRun = Effect.gen(function* () {
      const claimed = yield* QueueService.claim(
        JOBS_QUEUE,
        JobPayload,
        visibilityTimeout,
      ).pipe(
        Effect.catchTag("PayloadParseError", (error) =>
          queue
            .fail(error.jobId, { retryable: false })
            .pipe(Effect.as(Option.none())),
        ),
      )

      if (Option.isNone(claimed)) return true

      const job = claimed.value
      switch (job.payload._tag) {
        case "refresh-repository": {
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
          break
        }
        case "work-item-step": {
          const lifecycle = yield* WorkItemLifecycle
          const result = yield* Effect.result(
            lifecycle.runStep(job.payload.stepRunId),
          )

          if (result._tag === "Failure") {
            yield* Effect.logError("Work Item Lifecycle Job failed", {
              jobId: job.jobId,
              stepRunId: job.payload.stepRunId,
              error: formatLogError(result.failure),
            })
          } else if (result.success._tag === "noop") {
            yield* queue.acknowledge(job.jobId)
          }
          break
        }
      }

      return false
    })

    const poll = claimAndRun.pipe(
      Effect.catch((error) =>
        Effect.logError("Job queue poll failed", {
          error: formatLogError(error),
        }).pipe(Effect.as(true)),
      ),
      Effect.flatMap((idle) =>
        idle ? Effect.sleep(idlePollInterval) : Effect.void,
      ),
    )

    return yield* Effect.forever(poll)
  })

export const JobWorkerLive = Layer.effectDiscard(
  runJobWorker().pipe(Effect.forkScoped({ startImmediately: true })),
)
