import { Clock, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  type GitHubRepository,
  GitHubService,
  type GitHubServiceError,
  githubHelperCiRepairRejection,
} from "@ready-for-agent/github-service"
import type { CiRepairFailingRun } from "./ci-repair-work-item.js"
import type { StepRunRecord } from "./types.js"

export const CI_REPAIR_RETRY_POLL_MS = 30_000
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000

export const ciRepairRetryDeadline = (requestedAt: number): number =>
  requestedAt + RETRY_WINDOW_MS

const RunId = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
)
const Request = Schema.Struct({
  runId: RunId,
  attempt: RunId,
  requestedAt: Schema.Number,
  phase: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("waiting"),
      // Absent before the first observation, and on older stored requests.
      originalRunFinished: Schema.optionalKey(Schema.Boolean),
    }),
    // Dispatch was claimed, but a GitHub acknowledgement is not durable yet.
    Schema.Struct({ kind: Schema.Literal("submitted") }),
    Schema.Struct({ kind: Schema.Literal("accepted") }),
    Schema.Struct({
      kind: Schema.Literal("observed"),
      message: Schema.String,
    }),
  ]),
})
type Request = typeof Request.Type
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request))

const encodeRequest = ({ runId, attempt, requestedAt, phase }: Request) =>
  JSON.stringify({ runId, attempt, requestedAt, phase })

export const ciRepairRetryWaitingForOriginalRun = (
  raw: string | null | undefined,
  stepRuns: readonly StepRunRecord[],
): boolean => {
  if (raw == null) return false
  const request = decodeRequest(raw)
  if (Option.isNone(request) || request.value.phase.kind !== "waiting")
    return false
  const { originalRunFinished } = request.value.phase
  if (originalRunFinished !== undefined) return !originalRunFinished
  // Older requests recorded the observation only in Implement history.
  const identity = `${request.value.runId}:${request.value.attempt}`
  const activeNotes = [
    `GitHub run ${identity} has not finished; waiting for sibling jobs before retrying.`,
    `GitHub still reports run ${identity} in progress; waiting for eligibility.`,
  ]
  for (let index = stepRuns.length - 1; index >= 0; index -= 1) {
    const run = stepRuns[index]
    if (run?.step !== "implement" || run.reasonMessage === null) continue
    if (activeNotes.includes(run.reasonMessage)) return true
    // The old dispatch-race note could mean a replacement had already started.
    if (
      run.reasonMessage.startsWith("Adopted replacement attempt ") ||
      run.reasonMessage ===
        `GitHub changed run ${identity} before retry dispatch; re-observing.`
    )
      return false
  }
  return false
}

class CiRepairRetryError extends Schema.TaggedError<CiRepairRetryError>()(
  "CiRepairRetryError",
  { message: Schema.String },
) {}

const parseIdentity = (identity: string) => {
  const match = /^([1-9]\d*)(?::([1-9]\d*))?$/.exec(identity)
  if (match === null) return null
  const runId = Number(match[1])
  const attempt = Number(match[2] ?? "1")
  return Number.isSafeInteger(runId) && Number.isSafeInteger(attempt)
    ? { runId, attempt }
    : null
}

export const resolveObservedRetryTarget = (
  identity: string,
  runs: readonly CiRepairFailingRun[],
) => {
  const requested = parseIdentity(identity)
  if (requested === null) return null
  for (const run of runs) {
    const captured = parseIdentity(run.runIdentity)
    if (
      captured?.runId === requested.runId &&
      (!identity.includes(":") || captured.attempt === requested.attempt)
    ) {
      return captured
    }
  }
  return null
}

export const parseCiRepairRetryMarker = (output: string, preceding = "") => {
  // Earlier steps can invalidate the marker's uniqueness, but cannot end the reply.
  const resultLines = `${preceding}\n${output}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^READY_FOR_AGENT_RESULT:/i.test(line))
  const retryLine = resultLines.find((line) =>
    /^READY_FOR_AGENT_RESULT:\s*(?:RETRY_FAILED_JOBS|RERUN_JOBS)\b/i.test(line),
  )
  if (retryLine === undefined) return { kind: "absent" as const }
  const identity =
    /^READY_FOR_AGENT_RESULT:\s*(?:RETRY_FAILED_JOBS|RERUN_JOBS):\s*(\S+)$/i.exec(
      retryLine,
    )?.[1]
  if (
    resultLines.length !== 1 ||
    output.trim().split("\n").at(-1)?.trim() !== retryLine ||
    identity === undefined
  ) {
    return { kind: "invalid" as const }
  }
  return { kind: "requested" as const, identity }
}

export const loadCiRepairRetryRequest = (
  sql: SqlClient.SqlClient,
  workItemId: string,
) =>
  Effect.gen(function* () {
    const [row] = yield* sql.unsafe<{ ci_repair_retry: string | null }>(
      "SELECT ci_repair_retry FROM work_item WHERE id = ?",
      [workItemId],
    )
    const value = row?.ci_repair_retry
    if (value == null) return null
    const request = decodeRequest(value)
    if (Option.isNone(request)) {
      return yield* new CiRepairRetryError({
        message:
          "Could not read the stored CI retry request; no retry was sent.",
      })
    }
    return request.value
  })

const saveRequest = (workItemId: string, request: Request) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe("UPDATE work_item SET ci_repair_retry = ? WHERE id = ?", [
      encodeRequest(request),
      workItemId,
    ])
  })

/** Do not overwrite recovery's evidence if a poll overlapped dispatch. */
const replaceRequest = (workItemId: string, previous: Request, next: Request) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [updated] = yield* sql.unsafe<{ id: string }>(
      `UPDATE work_item SET ci_repair_retry = ?
       WHERE id = ? AND ci_repair_retry = ? RETURNING id`,
      [encodeRequest(next), workItemId, encodeRequest(previous)],
    )
    return updated !== undefined
  })

export const requestCiRepairRetry = (
  workItemId: string,
  sessionId: string,
  target: Pick<Request, "runId" | "attempt">,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = yield* Clock.currentTimeMillis
    const [recorded] = yield* sql.unsafe<{ id: string }>(
      `UPDATE work_item SET ci_repair_retry = ?, session_id = ?
       WHERE id = ? AND ci_repair_retry IS NULL RETURNING id`,
      [
        encodeRequest({
          ...target,
          requestedAt: now,
          phase: { kind: "waiting" },
        }),
        sessionId,
        workItemId,
      ],
    )
    if (recorded === undefined) {
      return yield* new CiRepairRetryError({
        message: "Could not record a new CI retry request; no retry was sent.",
      })
    }
  })

const pending = (note: string) => ({ kind: "pending" as const, note })
const observed = (message: string) => ({ kind: "observed" as const, message })
const statusOf = (error: GitHubServiceError) =>
  error._tag === "GitHubRequestError" ? error.statusCode : undefined

/** A lifecycle poll, with no agent turn while GitHub is still running. */
export const observeCiRepairRetry = (
  workItemId: string,
  repository: GitHubRepository,
  request: Request,
) =>
  Effect.gen(function* () {
    if (request.phase.kind === "observed") {
      return observed(request.phase.message)
    }
    const { runId, attempt } = request
    const identity = `${runId}:${attempt}`
    const deadlineExceeded = (lastRead?: string) => {
      const dispatchDetail =
        request.phase.kind === "submitted"
          ? " GitHub retry dispatch could not be confirmed; no automatic resend was attempted."
          : request.phase.kind === "accepted"
            ? " GitHub accepted the retry, but its replacement did not reach an observable terminal result."
            : ""
      return new CiRepairRetryError({
        message: `No terminal replacement for GitHub run ${identity} was observed within six hours.${dispatchDetail} Check the run before retrying or resetting this repair.${lastRead === undefined ? "" : ` Last observation: ${lastRead}`}`,
      })
    }
    const github = yield* GitHubService
    const read = github.readCiRepairRun
    const rerun = github.rerunFailedJobs
    if (read === undefined || rerun === undefined) {
      return yield* new CiRepairRetryError({
        message:
          "The GitHub connection does not support observed failed-job retries.",
      })
    }
    const forgeError = (operation: string, error: GitHubServiceError) => {
      const status = statusOf(error)
      const hint =
        status === 403 && !error.message.includes("Actions ")
          ? ` If the run is eligible, verify that the GitHub credential has Actions ${operation === "observe" ? "read" : "write"} access.`
          : ""
      return new CiRepairRetryError({
        message: `GitHub could not ${operation} run ${identity}${status === undefined ? "" : ` (HTTP ${status})`}: ${error.message}${hint}`,
      })
    }
    const load = read(repository, runId, attempt)
    const reading = yield* load.pipe(Effect.result)
    const now = yield* Clock.currentTimeMillis
    const expired = now >= ciRepairRetryDeadline(request.requestedAt)
    if (reading._tag === "Failure") {
      const error = reading.failure
      if (error._tag === "GitHubThrottledError") {
        if (expired) return yield* deadlineExceeded()
        return yield* error
      }
      const failure = forgeError("observe", error)
      if (
        error._tag === "GitHubRequestError" &&
        (error.retryable === true ||
          (error.statusCode === undefined && error.retryable !== false))
      ) {
        if (expired) return yield* deadlineExceeded(failure.message)
        const next =
          request.phase.kind === "waiting"
            ? "Will recheck eligibility before dispatch."
            : "Continuing to observe without resending the retry."
        return pending(`${failure.message} ${next}`)
      }
      return yield* failure
    }
    const run = reading.success
    const finish = (result: string) =>
      saveRequest(workItemId, {
        ...request,
        phase: { kind: "observed", message: result },
      }).pipe(Effect.as(observed(result)))

    // A worker can be offline past the deadline while GitHub finishes. The
    // final read can recover that result, but cannot extend the retry window.
    if (
      run.attempt > attempt &&
      run.status === "completed" &&
      run.conclusion !== null
    ) {
      const runLink = `https://github.com/${repository.projectPath}/actions/runs/${runId}`
      const link = `${runLink}/attempts/${run.attempt}`
      const failures = run.failedJobs.map(
        (job) => `- ${job.name}: ${job.conclusion} (${runLink}/job/${job.id})`,
      )
      return yield* finish(
        [
          `GitHub replacement attempt ${run.attempt} finished with conclusion ${run.conclusion}: ${link}`,
          ...failures,
          run.conclusion === "success"
            ? "The replacement succeeded. If no repository changes are needed, report the observed recovery and leave the worktree unchanged."
            : "Inspect these attempt-specific results and continue repairing. Do not report recovery unless CI is independently verified green.",
        ].join("\n"),
      )
    }
    if (expired) return yield* deadlineExceeded()
    if (run.attempt < attempt) {
      return pending(`Waiting for GitHub to report run ${identity}.`)
    }
    if (run.status !== "completed" || run.conclusion === null) {
      const originalRunFinished = run.attempt > attempt
      if (
        request.phase.kind === "waiting" &&
        request.phase.originalRunFinished !== originalRunFinished
      ) {
        yield* replaceRequest(workItemId, request, {
          ...request,
          phase: { kind: "waiting", originalRunFinished },
        })
      }
      return pending(
        originalRunFinished
          ? `Adopted replacement attempt ${run.attempt} of GitHub run ${runId}; waiting for it to finish.`
          : `GitHub run ${identity} has not finished; waiting for sibling jobs before retrying.`,
      )
    }
    if (request.phase.kind !== "waiting") {
      return pending(
        `Waiting for a replacement attempt of GitHub run ${identity}.`,
      )
    }
    if (
      ![
        "failure",
        "timed_out",
        "startup_failure",
        "cancelled",
        "action_required",
      ].includes(run.conclusion)
    ) {
      return yield* finish(
        `GitHub run ${identity} finished with conclusion ${run.conclusion}; no retry was sent. Determine whether CI is healthy before concluding.`,
      )
    }

    // Reserve before POST. If interrupted after the request left the process,
    // the next poll observes only; it must not send a duplicate on stale data.
    const submitted = {
      ...request,
      phase: { kind: "submitted" },
    } satisfies Request
    const readyToRetry = {
      ...request,
      phase: { kind: "waiting", originalRunFinished: true },
    } satisfies Request
    if (!(yield* replaceRequest(workItemId, request, submitted))) {
      return pending(
        `The GitHub retry of ${identity} has already been claimed; re-observing.`,
      )
    }
    const result = yield* rerun(repository, runId).pipe(Effect.result)
    if (result._tag === "Success") {
      yield* replaceRequest(workItemId, submitted, {
        ...submitted,
        phase: { kind: "accepted" },
      })
      return pending(
        `GitHub accepted the failed-job retry of ${identity}; waiting for its replacement attempt.`,
      )
    }
    const error = result.failure
    const status = statusOf(error)
    if (error._tag === "GitHubThrottledError") {
      yield* replaceRequest(workItemId, submitted, readyToRetry)
      return yield* error
    }
    if (error._tag === "GitHubRequestError" && error.requestNotSent) {
      yield* replaceRequest(workItemId, submitted, readyToRetry)
      return pending(
        `${error.message} No retry was sent; will recheck eligibility before dispatch.`,
      )
    }
    if (status !== undefined && status >= 400 && status < 500) {
      // An explicit rejection did not dispatch anything. A human or GitHub
      // may have started the replacement between our GET and POST.
      yield* replaceRequest(workItemId, submitted, readyToRetry)
      if (status === 403 || status === 409 || status === 422) {
        const after = yield* load.pipe(Effect.option)
        const markOriginalRunActive = replaceRequest(workItemId, readyToRetry, {
          ...readyToRetry,
          phase: { kind: "waiting", originalRunFinished: false },
        })
        if (
          Option.isSome(after) &&
          (after.value.attempt > attempt ||
            (after.value.attempt === attempt &&
              after.value.status !== "completed"))
        ) {
          if (after.value.attempt === attempt) {
            yield* markOriginalRunActive
          }
          return pending(
            `GitHub changed run ${identity} before retry dispatch; re-observing.`,
          )
        }
        if (
          githubHelperCiRepairRejection(status, error.message).reason ===
          "active"
        ) {
          yield* markOriginalRunActive
          return pending(
            `GitHub still reports run ${identity} in progress; waiting for eligibility.`,
          )
        }
      }
      return yield* forgeError("retry failed jobs for", error)
    }
    if (
      error._tag === "GitHubTlsTrustError" ||
      (error._tag === "GitHubRequestError" &&
        error.retryable === false &&
        status === undefined)
    ) {
      yield* replaceRequest(workItemId, submitted, readyToRetry)
      return yield* forgeError("retry failed jobs for", error)
    }
    // An ambiguous transport failure is not permission to submit again.
    // Keep the reservation and expose the details on the Step Run.
    return pending(
      `${forgeError("confirm retry dispatch for", error).message} Checking for a replacement before taking further action.`,
    )
  })
