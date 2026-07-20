import "@tanstack/react-start/server-only"
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
} from "effect"
import {
  DbService,
  RepositoryId,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import { formatUserFacingError } from "@ready-for-agent/github-service"
import {
  ISSUE_POLL_QUEUE,
  ISSUE_REFRESH_QUEUE,
  JOB_RECOVERY_RETRY_LIMIT,
  POLLING_AUTO_HEAL_BACKOFF,
  POLLING_AUTO_HEAL_KEY,
  enqueuePollingAutoHealJob,
  repairPollingSchedules,
  sampleIssuePollingDelay,
} from "@ready-for-agent/graphql-api"
import { IssueReconciler } from "@ready-for-agent/issue-reconciler"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { QueueService } from "@ready-for-agent/queue-service"
import {
  WorkItemLifecycle,
  WorkItemStepJob,
  syncNeedsHumanMergeHandoffs,
} from "@ready-for-agent/work-item-lifecycle"

/** Work Item lifecycle queue (unchanged). */
export const JOBS_QUEUE = "jobs"
export {
  ISSUE_POLL_QUEUE,
  ISSUE_REFRESH_QUEUE,
  JOB_RECOVERY_RETRY_LIMIT,
  POLLING_AUTO_HEAL_KEY,
  enqueuePollingAutoHealJob,
}
export const JOB_VISIBILITY_TIMEOUT = Duration.minutes(5)
const LIFECYCLE_JOB_VISIBILITY_GRACE = Duration.minutes(1)
const JOB_IDLE_POLL_INTERVAL = Duration.millis(1500)
const ORPHAN_RECOVERY_INTERVAL = Duration.seconds(30)
const REFRESH_REPOSITORY_TAG = "refresh-repository"
const POLLING_AUTO_HEAL_TAG = "polling-auto-heal"

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

const formatLogError = (error: unknown): string =>
  formatUserFacingError(error, "Unknown error")

const RefreshRepositoryJob = Schema.TaggedStruct("refresh-repository", {
  repositoryId: RepositoryId,
})

const PollingAutoHealJob = Schema.TaggedStruct("polling-auto-heal", {})

export const enqueueRefreshRepositoryJob = Effect.fn(
  "JobWorker.enqueueRefreshRepositoryJob",
)(function* (repositoryId: RepositoryId) {
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
}).pipe(Effect.withSpan("JobWorker.transferPersistedRefreshJobs"))

const repositoryHasGitHubCredential = Effect.fn(
  "JobWorker.repositoryHasGitHubCredential",
)(function* (githubOwner: string, githubRepo: string) {
  const keymaxxer = yield* KeymaxxerService
  if (keymaxxer.enabled === false) return true
  const credential = yield* keymaxxer.findSecret({
    provider: "github",
    account: `${githubOwner}/${githubRepo}`,
  })
  return credential !== null
})

const listCredentialedRepositoryIds = Effect.gen(function* () {
  const db = yield* DbService
  const repositories = yield* db.listRepositories
  const credentialed: string[] = []
  for (const repository of repositories) {
    const hasCredential = yield* repositoryHasGitHubCredential(
      repository.githubOwner,
      repository.githubRepo,
    )
    if (hasCredential) {
      credentialed.push(repository.id)
    }
  }
  return credentialed
})

const runPollingAutoHeal = Effect.fn("JobWorker.runPollingAutoHeal")(function* (
  sampleDelay: Effect.Effect<Duration.Duration>,
) {
  const credentialedRepositoryIds = yield* listCredentialedRepositoryIds
  yield* repairPollingSchedules({
    credentialedRepositoryIds,
    sampleDelay,
  })
})

const refreshRepository = Effect.fn("JobWorker.refreshRepository")(function* (
  repositoryId: RepositoryId,
) {
  const db = yield* DbService
  const reconciler = yield* IssueReconciler
  const repositories = yield* db.listRepositories
  const repository = repositories.find(({ id }) => id === repositoryId)

  if (repository === undefined) {
    return yield* new RepositoryNotFoundError({ repositoryId })
  }

  const summary = yield* reconciler.reconcile(repository)
  yield* syncNeedsHumanMergeHandoffs(repositoryId)
  yield* db.notifyIssuesChanged(repositoryId)
  return summary
})

export interface JobWorkerOptions {
  readonly idlePollInterval?: Duration.Duration
  readonly visibilityTimeout?: Duration.Duration
  readonly orphanRecoveryInterval?: Duration.Duration
  /** Override cadence sampling for deterministic tests. */
  readonly samplePollingDelay?: Effect.Effect<Duration.Duration>
  /** Override Auto-heal failure backoff for deterministic tests. */
  readonly sampleAutoHealBackoff?: Effect.Effect<Duration.Duration>
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

const finalizeManualRefresh = <A, E>(
  jobId: string,
  result: Result.Result<A, E>,
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

const finalizePollingAutoHeal = <A, E>(
  jobId: string,
  result: Result.Result<A, E>,
  sampleBackoff: Effect.Effect<Duration.Duration>,
) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    if (result._tag === "Failure") {
      yield* Effect.logError("Polling Auto-heal Job failed", {
        jobId,
        error: formatLogError(result.failure),
      })
      const delay = yield* sampleBackoff
      yield* queue.postponeKeyed(jobId, delay)
      return
    }
    yield* queue.acknowledge(jobId)
  })

const finalizeScheduledRefresh = <A, E>(
  jobId: string,
  repositoryId: RepositoryId,
  result: Result.Result<A, E>,
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

const payloadTag = (payload: unknown): string | undefined => {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "_tag" in payload &&
    typeof (payload as { _tag: unknown })._tag === "string"
  ) {
    return (payload as { _tag: string })._tag
  }
  return undefined
}

/**
 * One dedicated polling worker: always claim high-priority manual work before
 * scheduled recurring entries. Never interrupts a running reconciliation.
 */
const claimAndRunRefreshJob = (
  visibilityTimeout: Duration.Duration,
  sampleDelay: Effect.Effect<Duration.Duration>,
  sampleAutoHealBackoff: Effect.Effect<Duration.Duration>,
) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const highPriorityRaw = yield* queue.rawClaim(
      ISSUE_REFRESH_QUEUE,
      visibilityTimeout,
    )
    if (Option.isSome(highPriorityRaw)) {
      const job = highPriorityRaw.value
      const tag = payloadTag(job.payload)

      if (tag === POLLING_AUTO_HEAL_TAG) {
        const decoded = yield* Schema.decodeUnknownEffect(PollingAutoHealJob)(
          job.payload,
        ).pipe(Effect.result)
        if (decoded._tag === "Failure") {
          yield* queue.fail(job.jobId, { retryable: false })
          return "busy" as const
        }
        const result = yield* Effect.result(runPollingAutoHeal(sampleDelay))
        yield* finalizePollingAutoHeal(job.jobId, result, sampleAutoHealBackoff)
        return "busy" as const
      }

      if (tag === REFRESH_REPOSITORY_TAG) {
        const decoded = yield* Schema.decodeUnknownEffect(RefreshRepositoryJob)(
          job.payload,
        ).pipe(Effect.result)
        if (decoded._tag === "Failure") {
          yield* queue.fail(job.jobId, { retryable: false })
          return "busy" as const
        }
        const result = yield* Effect.result(
          refreshRepository(decoded.success.repositoryId),
        )
        yield* finalizeManualRefresh(
          job.jobId,
          result,
          decoded.success.repositoryId,
        )
        return "busy" as const
      }

      yield* queue.fail(job.jobId, { retryable: false })
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
        Result.succeed(undefined),
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
        Result.succeed(undefined),
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

/**
 * Claim-and-fork lifecycle Step Runs so multiple Work Items can progress in
 * parallel. Concurrency is bounded from Config: enough fibers that OpenCode
 * can reach max concurrent sessions, plus headroom for non-OpenCode steps.
 * OpenCode spawn concurrency is capped separately at the Opencode boundary.
 */
const runLifecycleClaimLoop = (
  generation: number,
  idlePollInterval: Duration.Duration,
  visibilityTimeout: Duration.Duration,
  orphanRecoveryInterval: Duration.Duration,
) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const lifecycle = yield* WorkItemLifecycle
    const db = yield* DbService
    const activeRuns = yield* Ref.make(0)
    const sleepIdle = yield* Schedule.toStepWithSleep(
      Schedule.spaced(idlePollInterval).pipe(Schedule.jittered),
    )
    const sleepBusy = yield* Schedule.toStepWithSleep(
      Schedule.spaced(Duration.millis(50)),
    )
    let nextOrphanRecoveryAt = 0
    const lifecycleJobVisibilityTimeout = Duration.millis(
      Math.max(
        ...Object.values(lifecycle.maxDurations).map(Duration.toMillis),
      ) + Duration.toMillis(LIFECYCLE_JOB_VISIBILITY_GRACE),
    )

    while (generation === currentWorkerGeneration()) {
      const now = yield* Clock.currentTimeMillis
      if (now >= nextOrphanRecoveryAt) {
        yield* lifecycle.recoverOrphanedStepRuns.pipe(
          Effect.catch((error) =>
            Effect.logError("Lifecycle orphan recovery failed", {
              error: formatLogError(error),
            }),
          ),
        )
        nextOrphanRecoveryAt = now + Duration.toMillis(orphanRecoveryInterval)
      }

      const maxConcurrentStepRuns = yield* db.getConfig.pipe(
        Effect.map((config) => {
          const maxWorkItems = Math.max(1, config.maxConcurrentWorkItems)
          const maxSessions = Math.max(1, config.maxConcurrentOpencodeSessions)
          // Fiber budget so Worker Slot admission and non-OpenCode steps are not undercut.
          return Math.max(maxWorkItems, maxSessions * 2)
        }),
        Effect.orElseSucceed(() => 5),
      )
      const active = yield* Ref.get(activeRuns)
      if (active >= maxConcurrentStepRuns) {
        yield* sleepBusy(undefined).pipe(Effect.asVoid)
        continue
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
        Effect.catch((error) =>
          Effect.logError("Lifecycle job queue poll failed", {
            error: formatLogError(error),
          }).pipe(Effect.as(Option.none())),
        ),
      )

      if (Option.isNone(claimed)) {
        yield* sleepIdle(undefined).pipe(Effect.asVoid)
        continue
      }

      const job = claimed.value
      yield* queue.extendVisibility(job.jobId, lifecycleJobVisibilityTimeout)
      yield* Ref.update(activeRuns, (n) => n + 1)
      yield* Effect.gen(function* () {
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
      }).pipe(
        Effect.ensuring(Ref.update(activeRuns, (n) => Math.max(0, n - 1))),
        Effect.forkDetach({ startImmediately: true }),
      )
    }
  })

/**
 * Host lifecycle and Issue polling workers as independent fibers that share one
 * generation token so HMR retires both together.
 */
export const runJobWorker = Effect.fn("JobWorker.runJobWorker")(function* (
  options: JobWorkerOptions = {},
) {
  const generation = nextWorkerGeneration()
  const idlePollInterval = options.idlePollInterval ?? JOB_IDLE_POLL_INTERVAL
  const visibilityTimeout = options.visibilityTimeout ?? JOB_VISIBILITY_TIMEOUT
  const orphanRecoveryInterval =
    options.orphanRecoveryInterval ?? ORPHAN_RECOVERY_INTERVAL
  const sampleDelay = options.samplePollingDelay ?? sampleIssuePollingDelay
  const sampleAutoHealBackoff =
    options.sampleAutoHealBackoff ?? Effect.succeed(POLLING_AUTO_HEAL_BACKOFF)

  yield* Effect.all(
    [
      runLifecycleClaimLoop(
        generation,
        idlePollInterval,
        visibilityTimeout,
        orphanRecoveryInterval,
      ),
      runQueuePollLoop(
        generation,
        idlePollInterval,
        claimAndRunRefreshJob(
          visibilityTimeout,
          sampleDelay,
          sampleAutoHealBackoff,
        ),
        "Issue polling job queue",
      ),
    ],
    { concurrency: "unbounded", discard: true },
  )
})

/**
 * Start the polling runtime and durably enqueue one high-priority Polling
 * Auto-heal Job without awaiting repair completion.
 *
 * Before accepting claims, interrupt any Step Runs still marked `running` from a
 * prior process generation so Jobs UI cannot show zombie RUNNING work.
 */
export const startJobWorker = Effect.fn("JobWorker.startJobWorker")(function* (
  options: JobWorkerOptions = {},
) {
  const lifecycle = yield* WorkItemLifecycle
  yield* lifecycle.interruptRunningStepRunsFromPriorWorker.pipe(
    Effect.tap((count) =>
      count > 0
        ? Effect.logWarning(
            "Interrupted Step Runs left running by a prior harness process",
            { count },
          )
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logError(
        "Failed to interrupt prior-process running Step Runs on startup",
        { error: formatLogError(error) },
      ),
    ),
  )
  yield* transferPersistedRefreshJobs
  yield* enqueuePollingAutoHealJob
  yield* runJobWorker(options).pipe(
    Effect.forkScoped({ startImmediately: true }),
  )
})

export const JobWorkerLive = Layer.effectDiscard(startJobWorker())
