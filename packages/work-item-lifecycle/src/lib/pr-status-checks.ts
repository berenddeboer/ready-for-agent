import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ulid } from "ulidx"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService } from "@ready-for-agent/db-service"
import {
  GREEN_NO_REVIEW_EVIDENCE_REASON,
  GitHubService,
  INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
  type PrStatusCheckDiagnostic,
  type PullRequestCheckStatus,
  type TerminalPrStatusCheck,
  isGitHubThrottledError,
  isRecognizedAutomatedReviewerName,
  workflowNameFromCheckName,
} from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import {
  AgentTurnForgeCredentialMissingError,
  InvalidCapturedAgentBackendError,
  agentTurnForgeCredentialGuidance,
  forgeDisplayName,
  resolveAgentTurnForgeAuth,
} from "./agent-turn-forge-auth.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  promptUserContentSection,
  sanitizePromptUserContent,
} from "./sanitize-prompt-user-content.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  STEP_RUN_REASON,
  type StepRunReasonCode,
} from "./types.js"
import { unwrapSentinelArgument } from "./unwrap-sentinel-argument.js"
import { workItemBranchName } from "./worktree-names.js"

export class PrStatusChecksContextError extends Schema.TaggedErrorClass<PrStatusChecksContextError>()(
  "PrStatusChecksContextError",
  {
    message: Schema.String,
  },
) {}

export class PrStatusChecksOpenCodeError extends Schema.TaggedErrorClass<PrStatusChecksOpenCodeError>()(
  "PrStatusChecksOpenCodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PrStatusChecksUnresolvedError extends Schema.TaggedErrorClass<PrStatusChecksUnresolvedError>()(
  "PrStatusChecksUnresolvedError",
  {
    message: Schema.String,
  },
) {}

/** Timing evidence from the GitHub PR check snapshot for Check-Start Anchors. */
export type PrStatusCheckTimingEvidence = {
  readonly createdAt: Date | null
  readonly headSha: string | null
  readonly headPushedAt: Date | null
  readonly isDraft: boolean | null
}

export type PrStatusCheckResult =
  | ({
      readonly _tag: "pending"
    } & PrStatusCheckTimingEvidence)
  | ({
      readonly _tag: "expected"
    } & PrStatusCheckTimingEvidence)
  | ({
      readonly _tag: "no_checks"
    } & PrStatusCheckTimingEvidence)
  | ({
      readonly _tag: "succeeded"
    } & PrStatusCheckTimingEvidence)
  | ({
      readonly _tag: "failed"
    } & PrStatusCheckTimingEvidence)
  | ({
      readonly _tag: "closed"
    } & PrStatusCheckTimingEvidence)
  | ({
      readonly _tag: "handoff_needed"
    } & PrStatusCheckTimingEvidence)
  | ({
      readonly _tag: "conflict"
      readonly retiredCheckIds: readonly string[]
    } & PrStatusCheckTimingEvidence)

export type PrStatusCheckInvestigationResult =
  | {
      readonly _tag: "processed"
      readonly handledCheckIds: readonly string[]
      /** Optional operator-visible reason when handled without an Agent Turn. */
      readonly reasonCode?: StepRunReasonCode
      readonly reasonNote?: string
    }
  | {
      readonly _tag: "checks_triggered"
      readonly handledCheckIds: readonly string[]
      /**
       * True when investigate already persisted the Check-Start Anchor at the
       * trigger event (for example a successful authorized review rerun). False
       * when lifecycle must record the anchor at step completion.
       */
      readonly checkStartAnchorRecorded: boolean
    }
  | {
      readonly _tag: "needs_human"
      readonly reason: string
      readonly handledCheckIds: readonly string[]
    }

/** Autonomous whole-review workflow reruns allowed after the initial attempt. */
export const AUTOMATED_REVIEW_RERUN_LIMIT = 3

/**
 * Autonomous whole-workflow reruns allowed for harness-classified incomplete
 * Automated Review Output (finished banner + unchecked substantive task) on the
 * same (work item, head SHA, workflow run). One recovery attempt only.
 */
export const AUTOMATED_REVIEW_INCOMPLETE_RERUN_LIMIT = 1

/**
 * Format an operator-facing automated-review workflow/check identity so Needs
 * Human copy cannot be read as blaming the Work Item implement Agent Model.
 */
export const formatAutomatedReviewWorkflowIdentity = (
  workflowName: string | null,
  workflowRunId?: number,
): string => {
  const name = workflowName?.trim()
  if (name !== undefined && name !== "") {
    // Already a workflow-run fallback phrase — do not wrap in quotes.
    if (/^workflow run \d+$/i.test(name)) {
      return name
    }
    return `workflow "${name}"`
  }
  if (workflowRunId !== undefined) {
    return `workflow run ${workflowRunId}`
  }
  return "workflow"
}

export const automatedReviewRerunLimitReason = (
  workflowIdentity: string,
): string =>
  `Automated review ${workflowIdentity} hit the autonomous rerun limit (${AUTOMATED_REVIEW_RERUN_LIMIT}); inspect or run that GitHub review workflow or check manually, then Retry checks.`

export const automatedReviewIncompleteRerunLimitReason = (
  workflowIdentity: string,
): string =>
  `Automated review ${workflowIdentity} is still incomplete after autonomous recovery was already used on this workflow run; inspect or run that GitHub review workflow or check manually, then Retry checks.`

interface ObservedPrStatusCheckRow {
  readonly id: string
  readonly external_id: string
  readonly name: string
  readonly outcome: "green" | "red"
  readonly handled_at: number | null
}

const resolveContext = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    if (context.worktreePath === null || context.worktreePath.trim() === "") {
      return yield* new PrStatusChecksContextError({
        message: "PR status checks require a persisted worktree path",
      })
    }
    if (context.sessionId === null || context.sessionId.trim() === "") {
      return yield* new PrStatusChecksContextError({
        message:
          "PR status checks require a Session ID persisted by a successful Implement Step Run",
      })
    }
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new PrStatusChecksContextError({
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    const branch = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })
    return {
      repository,
      branch,
      worktreePath: context.worktreePath,
      sessionId: context.sessionId,
    }
  })

const listObservedChecks = (workItemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return (yield* sql.unsafe(
      `SELECT id, external_id, name, outcome, handled_at
       FROM pr_status_check
       WHERE work_item_id = ?`,
      [workItemId],
    )) as readonly ObservedPrStatusCheckRow[]
  })

const observeTerminalChecks = (
  workItemId: string,
  terminalChecks: readonly TerminalPrStatusCheck[],
) =>
  Effect.gen(function* () {
    if (terminalChecks.length === 0) {
      return
    }
    const sql = yield* SqlClient.SqlClient
    const now = yield* Clock.currentTimeMillis
    const existing = yield* listObservedChecks(workItemId)
    const known = new Set(existing.map((row) => row.external_id))
    for (const check of terminalChecks) {
      if (known.has(check.externalId)) {
        continue
      }
      yield* sql.unsafe(
        `INSERT INTO pr_status_check (
           id, work_item_id, external_id, name, outcome,
           handled_at, observed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          `psc-${ulid()}`,
          workItemId,
          check.externalId,
          check.name,
          check.outcome,
          now,
          now,
          now,
        ],
      )
      known.add(check.externalId)
    }
  })

const listUnhandledChecks = (workItemId: string) =>
  Effect.gen(function* () {
    const observed = yield* listObservedChecks(workItemId)
    return observed.filter((row) => row.handled_at === null)
  })

const retireUnhandledRedChecks = (workItemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = yield* Clock.currentTimeMillis
    yield* sql.unsafe(
      `UPDATE pr_status_check
       SET handled_at = ?, updated_at = ?
       WHERE work_item_id = ? AND outcome = 'red' AND handled_at IS NULL`,
      [now, now, workItemId],
    )
  })

const timingEvidence = (status: {
  readonly createdAt: Date | null
  readonly headSha: string | null
  readonly headPushedAt: Date | null
  readonly isDraft: boolean | null
}): PrStatusCheckTimingEvidence => ({
  createdAt: status.createdAt,
  headSha: status.headSha,
  headPushedAt: status.headPushedAt,
  isDraft: status.isDraft,
})

export const watchPrStatusChecks = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const { repository, branch } = yield* resolveContext(context)
    let status: PullRequestCheckStatus
    // Forge dispatch: GitLab head-pipeline jobs, Azure DevOps build
    // validation / branch policy checks, or GitHub Checks/statuses.
    switch (repository.forge) {
      case "gitlab": {
        const gitlab = yield* GitLabService
        status = yield* gitlab.getPullRequestCheckStatus(repository, branch)
        break
      }
      case "azure-devops": {
        const azureDevOps = yield* AzureDevOpsService
        status = yield* azureDevOps.getPullRequestCheckStatus(
          repository,
          branch,
        )
        break
      }
      case "github": {
        const github = yield* GitHubService
        status = yield* github.getPullRequestCheckStatus(repository, branch)
        break
      }
      default: {
        const _exhaustive: never = repository.forge
        return _exhaustive
      }
    }
    const evidence = timingEvidence(status)
    const terminalChecks =
      status._tag === "pending" ||
      status._tag === "expected" ||
      status._tag === "succeeded" ||
      status._tag === "failed"
        ? status.terminalChecks
        : []
    yield* observeTerminalChecks(context.workItemId, terminalChecks)
    // A successful aggregate proves any retained red executions are obsolete
    // (for example, an operator reran a failed workflow successfully).
    if (status._tag === "succeeded") {
      yield* retireUnhandledRedChecks(context.workItemId)
    }
    const unhandled = yield* listUnhandledChecks(context.workItemId)
    if (status._tag === "closed") {
      return {
        _tag: "closed",
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    if (status.mergeability === "conflicting") {
      return {
        _tag: "conflict",
        retiredCheckIds: unhandled.map((check) => check.id),
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    if (status.mergeability === "unknown") {
      return {
        _tag: "pending",
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    if (unhandled.length > 0) {
      const hasUnhandledRed = unhandled.some((check) => check.outcome === "red")
      // Terminals are already recorded; defer green-only Status Check Handoffs
      // while rollup is still pending. Red recovery stays immediate so a
      // failure is not masked by later checks, and includes accumulated greens.
      if (status._tag === "pending" && !hasUnhandledRed) {
        return {
          _tag: "pending",
          ...evidence,
        } satisfies PrStatusCheckResult
      }
      return {
        _tag: "handoff_needed",
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    if (status._tag === "no_checks") {
      return {
        _tag: "no_checks",
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    if (status._tag === "expected") {
      return {
        _tag: "expected",
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    if (status._tag === "pending") {
      return {
        _tag: "pending",
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    if (status._tag === "failed") {
      return {
        _tag: "failed",
        ...evidence,
      } satisfies PrStatusCheckResult
    }
    return {
      _tag: "succeeded",
      ...evidence,
    } satisfies PrStatusCheckResult
  })

type ParsedInvestigationResult =
  | "processed"
  | "checks_triggered"
  | { readonly _tag: "needs_human"; readonly reason: string }
  | { readonly _tag: "failed"; readonly reason: string }
  | {
      readonly _tag: "rerun_review"
      readonly workflowRunId: number
      readonly workflowName: string | null
    }

export const parseInvestigationResult = (
  output: string,
): ParsedInvestigationResult | null => {
  const lines = output.split("\n").map((line) => line.trim())
  const nonEmptyLines = lines.filter((line) => line !== "")
  const resultLines = lines.filter((line) =>
    /^READY_FOR_AGENT_RESULT:/i.test(line),
  )
  const finalLine = nonEmptyLines.at(-1)
  if (
    resultLines.length !== 1 ||
    finalLine === undefined ||
    finalLine !== resultLines[0]
  ) {
    return null
  }
  if (/^READY_FOR_AGENT_RESULT:\s*PROCESSED$/i.test(finalLine)) {
    return "processed"
  }
  if (/^READY_FOR_AGENT_RESULT:\s*CHECKS_TRIGGERED$/i.test(finalLine)) {
    return "checks_triggered"
  }
  const rerunReview = finalLine.match(
    /^READY_FOR_AGENT_RESULT:\s*RERUN_REVIEW\s*:\s*(\S+)(?:\s+(.+))?$/i,
  )
  if (rerunReview?.[1] !== undefined) {
    const workflowRunId = Number(unwrapSentinelArgument(rerunReview[1]))
    if (Number.isSafeInteger(workflowRunId) && workflowRunId > 0) {
      const workflowNameRaw =
        rerunReview[2] === undefined
          ? ""
          : unwrapSentinelArgument(rerunReview[2])
      const workflowName =
        workflowNameRaw !== "" ? workflowNameRaw.slice(0, 200) : null
      return {
        _tag: "rerun_review",
        workflowRunId,
        workflowName,
      }
    }
  }
  const needsHuman = finalLine.match(
    /^READY_FOR_AGENT_RESULT:\s*NEEDS_HUMAN\s*:\s*(.+)$/i,
  )
  if (needsHuman?.[1] !== undefined) {
    const reason = unwrapSentinelArgument(needsHuman[1])
    if (reason !== "") {
      return {
        _tag: "needs_human",
        reason: reason.slice(0, 500),
      }
    }
  }
  const failed = finalLine.match(
    /^READY_FOR_AGENT_RESULT:\s*FAILED\s*:\s*(.+)$/i,
  )
  if (failed?.[1] !== undefined) {
    const reason = unwrapSentinelArgument(failed[1])
    if (reason !== "") {
      return {
        _tag: "failed",
        reason: reason.slice(0, 500),
      }
    }
  }
  return null
}

/** True when any READY_FOR_AGENT_RESULT line is present (valid or not). */
const hasInvestigationResultLine = (output: string): boolean =>
  output
    .split("\n")
    .some((line) => /^READY_FOR_AGENT_RESULT:/i.test(line.trim()))

/**
 * Count durable review-rerun permits for a budget lane.
 * - concrete signature id: that incomplete-signature lane only
 * - `null`: general agent-reported RERUN_REVIEW lane only (`signature IS NULL`)
 * - `"any"`: every permit on the scope (legacy null-signature agent reruns plus
 *   incomplete-tagged ones), so the one-retry incomplete circuit breaker treats
 *   prior recovery attempts as already spent
 */
const countAutomatedReviewReruns = (
  workItemId: string,
  headSha: string,
  workflowRunId: number,
  signature: string | null | "any",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows =
      signature === "any"
        ? ((yield* sql.unsafe(
            `SELECT COUNT(*) AS count FROM automated_review_rerun
             WHERE work_item_id = ?
               AND head_sha = ?
               AND workflow_run_id = ?`,
            [workItemId, headSha, String(workflowRunId)],
          )) as readonly { readonly count: number }[])
        : signature === null
          ? ((yield* sql.unsafe(
              `SELECT COUNT(*) AS count FROM automated_review_rerun
             WHERE work_item_id = ?
               AND head_sha = ?
               AND workflow_run_id = ?
               AND signature IS NULL`,
              [workItemId, headSha, String(workflowRunId)],
            )) as readonly { readonly count: number }[])
          : ((yield* sql.unsafe(
              `SELECT COUNT(*) AS count FROM automated_review_rerun
             WHERE work_item_id = ?
               AND head_sha = ?
               AND workflow_run_id = ?
               AND signature = ?`,
              [workItemId, headSha, String(workflowRunId), signature],
            )) as readonly { readonly count: number }[])
    return Number(rows[0]?.count ?? 0)
  })

const reserveAutomatedReviewRerun = (
  workItemId: string,
  headSha: string,
  workflowRunId: number,
  workflowName: string | null,
  options?: {
    readonly limit?: number
    /**
     * Null = general agent budget. Set = incomplete-signature budget; prior
     * permits on this scope with any signature (including legacy null) count
     * toward the one-retry incomplete limit.
     */
    readonly signature?: string | null
  },
) =>
  Effect.gen(function* () {
    const limit = options?.limit ?? AUTOMATED_REVIEW_RERUN_LIMIT
    const signature = options?.signature ?? null
    // Incomplete recovery: any prior whole-workflow rerun on this scope already
    // spent the single recovery attempt (including agent RERUN_REVIEW rows from
    // before harness body-parse tagged permits with the incomplete signature).
    const used = yield* countAutomatedReviewReruns(
      workItemId,
      headSha,
      workflowRunId,
      signature === null ? null : "any",
    )
    if (used >= limit) {
      return { _tag: "exhausted" as const }
    }
    const sql = yield* SqlClient.SqlClient
    const now = yield* Clock.currentTimeMillis
    const id = `arr-${ulid()}`
    yield* sql.unsafe(
      `INSERT INTO automated_review_rerun (
         id, work_item_id, head_sha, workflow_run_id, workflow_name,
         signature, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      [
        id,
        workItemId,
        headSha,
        String(workflowRunId),
        workflowName,
        signature,
        now,
        now,
      ],
    )
    return { _tag: "reserved" as const, id }
  })

/** A confirmed GitHub throttle never started the rerun, so it consumes no budget. */
const releaseThrottledAutomatedReviewRerun = (permitId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `DELETE FROM automated_review_rerun
       WHERE id = ? AND status = 'reserved'`,
      [permitId],
    )
  })

/** Mark the permit complete and record the Check-Start Anchor together. */
const completeAuthorizedReviewRerun = (
  permitId: string,
  workItemId: string,
  headSha: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = yield* Clock.currentTimeMillis
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `UPDATE automated_review_rerun
           SET status = 'completed', updated_at = ?
           WHERE id = ?`,
          [now, permitId],
        )
        // Anchor must be durable as soon as the GitHub rerun succeeds so a
        // crash before step completion cannot drop the catch-up window.
        yield* sql.unsafe(
          `UPDATE work_item
           SET check_start_anchor_at = ?,
               check_start_anchor_head_sha = ?,
               updated_at = ?
           WHERE id = ?`,
          [now, headSha, now, workItemId],
        )
      }),
    )
  })

const sourceLabel = (externalId: string): string => {
  if (externalId.startsWith("actions-job:")) {
    return "Actions job"
  }
  if (externalId.startsWith("status:")) {
    return "commit status"
  }
  if (externalId.startsWith("gitlab-job:")) {
    return "GitLab pipeline job"
  }
  if (externalId.startsWith("azure-policy:")) {
    return "Azure DevOps policy evaluation"
  }
  if (externalId.startsWith("azure-status:")) {
    return "Azure DevOps pull request status"
  }
  return "unknown source"
}

/** Format one red check line for investigation prompts (exported for tests). */
export const formatRedCheckLine = (check: {
  readonly name: string
  readonly external_id: string
}): string =>
  // Check names are mid-line fragments: sanitize tags only (no wrap).
  `- ${sanitizePromptUserContent(check.name)} (external id: ${check.external_id}, source: ${sourceLabel(check.external_id)})`

/** Format one harness diagnostic block for investigation prompts (exported for tests). */
export const formatDiagnosticBlock = (
  diagnostic: PrStatusCheckDiagnostic,
): string => {
  const header = `### ${sanitizePromptUserContent(diagnostic.name)} (${diagnostic.externalId}, source: ${diagnostic.source})`
  const urlLine =
    diagnostic.htmlUrl === null
      ? "HTML URL: none"
      : `HTML URL: ${diagnostic.htmlUrl}`
  if (diagnostic.logFetch._tag === "ok") {
    const pathLine =
      diagnostic.logFetch.localPath === null
        ? "Local log path: none"
        : `Local log path: ${diagnostic.logFetch.localPath}`
    return [
      header,
      urlLine,
      pathLine,
      "Log excerpt (use this evidence first):",
      promptUserContentSection("check_log", diagnostic.logFetch.excerpt),
    ].join("\n")
  }
  return [
    header,
    urlLine,
    `Log fetch unavailable: ${sanitizePromptUserContent(diagnostic.logFetch.reason)}`,
  ].join("\n")
}

const buildInvestigationWorkPrompt = (
  forge: "github" | "gitlab" | "azure-devops",
  checks: readonly ObservedPrStatusCheckRow[],
  diagnostics: readonly PrStatusCheckDiagnostic[],
): string => {
  const redChecks = checks.filter((check) => check.outcome === "red")
  const hasGreen = checks.some((check) => check.outcome === "green")
  const lines = [
    "Process the following PR Status Check results for the pull request on this worktree.",
  ]
  if (redChecks.length > 0) {
    lines.push(
      "Diagnose and fix these failing checks when possible:",
      ...redChecks.map(formatRedCheckLine),
      ...(forge === "github"
        ? [
            "Fine-grained GitHub PATs often cannot use the Checks API; HTTP 403 on Checks endpoints is expected and is not a credential failure by itself. Prefer Actions job logs for external ids of the form actions-job:<id>.",
            "When calling `gh api` with query parameters on GET endpoints, pass `--method GET` with `-f` (or use a GET-safe invocation). Bare `-f` defaults to POST and can produce misleading 404 responses.",
            "For transient infrastructure failures (for example GitHub 503, runner outages, or flaky network during the check), restart the failed checks when appropriate so new executions can run before concluding the handoff cannot progress.",
          ]
        : forge === "gitlab"
          ? [
              "Use the supplied GitLab pipeline-job traces first; call the GitLab REST API only when more detail is needed.",
              "For transient infrastructure failures (for example GitLab 503, runner outages, or flaky network during the job), restart the failed pipeline jobs when appropriate so new executions can run before concluding the handoff cannot progress.",
            ]
          : [
              "Use the supplied Azure DevOps build validation / branch policy diagnostics first; call the Azure DevOps REST API only when more detail is needed.",
              "For transient infrastructure failures (for example Azure DevOps outages or flaky network during the check), restart the failed checks when appropriate so new executions can run before concluding the handoff cannot progress.",
            ]),
    )
    if (diagnostics.length > 0) {
      const forgeLabel = forgeDisplayName(forge)
      lines.push(
        `Harness diagnostics for the red checks follow. Use these artifacts first; only call ${forgeLabel} for additional detail if needed.`,
        ...diagnostics.map(formatDiagnosticBlock),
      )
    }
    lines.push(
      "Fix the underlying problem when possible, verify the fix, commit it, and push it to the existing PR branch.",
    )
  }
  if (hasGreen && forge === "github") {
    lines.push(
      "One or more automated reviews may have completed, but an automated reviewer can stop semantically incomplete even when GitHub reports its check and workflow as successful. Inspect the latest relevant automated-review run and comment, when either exists, before deciding what to do.",
      'Do not assume an automated review exists merely because CI is present. Workflow or job names alone (including names containing "review" or "PR Review") are not positive review evidence. Positive evidence requires an executed reviewer job or step, or a comment from a recognized automated reviewer; ordinary CI, repository configuration, and generic bot activity are not review evidence.',
      "A skipped workflow or job with no executed reviewer steps and no recognized automated-review comment is not an incomplete review and is not review evidence. Treat it as not applicable: there is no review output to process.",
      "If no relevant automated-review run or comment exists, that is a normal no-op and does not require proof that review automation is unconfigured. Do not request a review workflow rerun solely because a skipped reviewer produced no comment.",
      "Once an automated-review check is terminal, its Automated Review Output is final: do not wait for later comments. A successful terminal review with no relevant comment means no feedback and must not be rerun.",
      "Use provider-specific progress artifacts as evidence of incompleteness only when a positively identified review comment is present but visibly incomplete. Strong evidence can include a finished banner combined with unchecked substantive review tasks, a remaining working spinner, and no final findings or synthesis. Do not treat arbitrary Markdown checkboxes in unrelated pull-request comments as an automated-review progress list.",
      "Correlate the latest relevant comment with the latest relevant run attempt. Do not rerun because of a stale incomplete comment when a newer attempt completed its review successfully.",
      "Present, positively identified, visibly incomplete Automated Review Output requires a whole-review workflow rerun in this turn (even when the run concluded success). Do not call GitHub workflow rerun APIs yourself; the harness authorizes and executes reruns. Do not use a failed-jobs-only rerun for a technically successful run.",
      "Requesting a terminal incomplete review rerun is required recovery, not optional feedback handling. Report FAILED for a technical inability to inspect the relevant review state. Report NEEDS_HUMAN only when evidence shows that an operator must perform or decide the required action.",
      "For a genuinely completed latest review, address worthwhile feedback. A completed review with no worthwhile feedback, or a successful terminal review with no relevant comment, still needs no changes or rerun.",
      "If review feedback requires changes, verify them, commit them, and push the commit to the existing PR branch.",
    )
  }
  lines.push(
    "If you create a commit during this handoff, after pushing it post one comment on the existing pull request that includes the commit SHA, summarizes the changes and verification, identifies the review feedback addressed, and lists any review feedback declined with a brief reason (or says none was declined).",
    "Do not post this summary comment when you did not create a commit.",
    "Do not create or merge another pull request.",
  )
  return lines.join("\n")
}

/** Shared outcome contract for status-check work, recovery, and fallback. */
const investigationOutcomeContractLines = (
  forge: "github" | "gitlab" | "azure-devops" = "github",
): readonly string[] => [
  "You may include a concise work and verification summary before the result line.",
  "End your final response with exactly one machine-readable result line:",
  "READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED",
  "Use CHECKS_TRIGGERED when you completed an action expected to create replacement check executions (for example a commit and push, or successfully restarting failed checks).",
  "READY_FOR_AGENT_RESULT: PROCESSED",
  "Use PROCESSED when the handoff is handled and no replacement execution is expected: for example a green-only handoff with no relevant automated-review run or comment (including a skipped reviewer with no review output), a successful terminal review with no relevant comment (no feedback), or a genuinely completed review that had nothing to address.",
  "Do not report PROCESSED for a present, positively identified, visibly incomplete automated review that still needs a whole-workflow rerun. Request the rerun instead.",
  ...(forge === "github"
    ? [
        "When positive review evidence shows present, positively identified, visibly incomplete Automated Review Output that needs a whole-workflow rerun, do not call GitHub yourself. Report the workflow run id (and optional workflow name) so the harness can authorize and execute the rerun:",
        "READY_FOR_AGENT_RESULT: RERUN_REVIEW: <workflow_run_id>",
        "READY_FOR_AGENT_RESULT: RERUN_REVIEW: <workflow_run_id> <workflow_name>",
      ]
    : []),
  "If this handoff contained red checks and you made no commit, push, check restart, or other action capable of producing a new execution, leaving the PR red, you must not report PROCESSED or CHECKS_TRIGGERED. Report:",
  "READY_FOR_AGENT_RESULT: FAILED: <concise reason>",
  "Also use FAILED when a technical or observability failure prevented you from determining the relevant review state.",
  "Use NEEDS_HUMAN only when evidence shows that an operator must perform or decide a required action:",
  "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
]

const buildInvestigationOutcomeFallbackPrompt = (
  forge: "github" | "gitlab" | "azure-devops" = "github",
): string =>
  [
    "Based only on the PR status-check work you just did in this session, report the outcome.",
    "Do not make further code changes unless required to answer accurately.",
    ...investigationOutcomeContractLines(forge),
  ].join("\n")

/** Recovery prompt after a FAILED investigation outcome (exported for tests). */
export const buildInvestigationRecoveryPrompt = (
  reason: string,
  forge: "github" | "gitlab" | "azure-devops" = "github",
): string =>
  [
    "Make one focused recovery attempt to process the PR Status Check Handoff.",
    "Your previous outcome was FAILED.",
    promptUserContentSection("failed_reason", reason),
    "Re-check the current pull request and retry the failed inspection or any safe action that can produce a replacement check execution, including restarting an appropriate failed workflow.",
    "Do not create an empty or no-op commit merely to restart checks.",
    ...investigationOutcomeContractLines(forge),
  ].join("\n")

export const investigatePrStatusChecks = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const { repository, branch, worktreePath, sessionId } =
      yield* resolveContext(context)
    const unhandled = yield* listUnhandledChecks(context.workItemId)
    if (unhandled.length === 0) {
      return {
        _tag: "processed",
        handledCheckIds: [],
      } satisfies PrStatusCheckInvestigationResult
    }
    const redChecks = unhandled.filter((check) => check.outcome === "red")
    // Green-only handoffs: skip the Agent Turn when harness-owned observation
    // proves there is no positive automated-review evidence. GitLab starts with
    // an empty recognized-reviewer set, so green-only is always this fast path.
    if (redChecks.length === 0) {
      if (repository.forge === "gitlab") {
        const handledCheckIds = unhandled.map((check) => check.id)
        yield* Effect.logInfo(
          "Status Check Handoff fast path: no automated-review evidence",
          {
            reason: GREEN_NO_REVIEW_EVIDENCE_REASON,
            workItemId: context.workItemId,
            handledCheckCount: handledCheckIds.length,
            forge: "gitlab",
          },
        )
        return {
          _tag: "processed",
          handledCheckIds,
          reasonCode: STEP_RUN_REASON.greenNoReviewEvidence,
          reasonNote: GREEN_NO_REVIEW_EVIDENCE_REASON,
        } satisfies PrStatusCheckInvestigationResult
      }
      if (repository.forge === "github") {
        const github = yield* GitHubService
        const evidence = yield* github
          .observeAutomatedReviewEvidence(
            repository,
            branch,
            unhandled.map((check) => ({
              externalId: check.external_id,
              name: check.name,
            })),
          )
          .pipe(
            Effect.catch((cause) =>
              isGitHubThrottledError(cause)
                ? Effect.fail(cause)
                : Effect.gen(function* () {
                    const reason =
                      "message" in cause &&
                      typeof cause.message === "string" &&
                      cause.message.trim() !== ""
                        ? cause.message
                        : "Failed to observe automated review evidence"
                    yield* Effect.logWarning(
                      "Status Check Handoff: automated-review observation failed; treating as ambiguous",
                      {
                        workItemId: context.workItemId,
                        reason,
                      },
                    )
                    return {
                      _tag: "ambiguous" as const,
                      reason,
                    }
                  }),
            ),
          )
        if (evidence._tag === "none") {
          const handledCheckIds = unhandled.map((check) => check.id)
          yield* Effect.logInfo(
            "Status Check Handoff fast path: no automated-review evidence",
            {
              reason: GREEN_NO_REVIEW_EVIDENCE_REASON,
              workItemId: context.workItemId,
              handledCheckCount: handledCheckIds.length,
            },
          )
          return {
            _tag: "processed",
            handledCheckIds,
            reasonCode: STEP_RUN_REASON.greenNoReviewEvidence,
            reasonNote: GREEN_NO_REVIEW_EVIDENCE_REASON,
          } satisfies PrStatusCheckInvestigationResult
        }
        // Harness-classified incomplete Automated Review Output: at most one
        // whole-workflow recovery rerun for this (work item, head, run), then
        // Needs Human — without an Investigate Agent Turn rediscovery loop.
        if (evidence._tag === "incomplete") {
          const handledCheckIds = unhandled.map((check) => check.id)
          const workflowName =
            evidence.workflowName ??
            (() => {
              const recognized = unhandled.find((check) =>
                isRecognizedAutomatedReviewerName(check.name),
              )
              return recognized !== undefined
                ? workflowNameFromCheckName(recognized.name)
                : null
            })()
          const workflowIdentity = formatAutomatedReviewWorkflowIdentity(
            workflowName,
            evidence.workflowRunId ?? undefined,
          )
          if (
            evidence.workflowRunId === null ||
            !Number.isSafeInteger(evidence.workflowRunId) ||
            evidence.workflowRunId <= 0
          ) {
            // Harness already classified incompleteness; do not spend an
            // Investigate Agent Turn rediscovering it without a run id.
            yield* Effect.logInfo(
              "Status Check Handoff: incomplete automated review without workflow run id",
              {
                workItemId: context.workItemId,
                signature: evidence.signature,
                detail: evidence.detail,
              },
            )
            return {
              _tag: "needs_human",
              reason: `Automated review ${workflowIdentity} is visibly incomplete but the harness could not resolve a workflow run id to authorize recovery; inspect or run that GitHub review workflow or check manually, then Retry checks.`,
              handledCheckIds,
            } satisfies PrStatusCheckInvestigationResult
          }
          const status = yield* github
            .getPullRequestCheckStatus(repository, branch)
            .pipe(
              Effect.mapError((cause) =>
                isGitHubThrottledError(cause)
                  ? cause
                  : new PrStatusChecksContextError({
                      message:
                        "message" in cause &&
                        typeof cause.message === "string" &&
                        cause.message.trim() !== ""
                          ? `Failed to resolve PR head for incomplete review recovery: ${cause.message}`
                          : "Failed to resolve PR head for incomplete review recovery",
                    }),
              ),
            )
          const headSha = status.headSha
          if (headSha === null || headSha.trim() === "") {
            return yield* new PrStatusChecksUnresolvedError({
              message:
                "Manual fixing may be required. Could not resolve the pull request head SHA to authorize an incomplete automated review recovery rerun. Please fix or rerun the checks on GitHub, then click Retry checks.",
            })
          }
          const permit = yield* reserveAutomatedReviewRerun(
            context.workItemId,
            headSha,
            evidence.workflowRunId,
            workflowName,
            {
              limit: AUTOMATED_REVIEW_INCOMPLETE_RERUN_LIMIT,
              signature: evidence.signature,
            },
          )
          if (permit._tag === "exhausted") {
            yield* Effect.logInfo(
              "Status Check Handoff: incomplete automated review recovery exhausted",
              {
                workItemId: context.workItemId,
                headSha,
                workflowRunId: evidence.workflowRunId,
                signature: evidence.signature,
              },
            )
            return {
              _tag: "needs_human",
              reason:
                automatedReviewIncompleteRerunLimitReason(workflowIdentity),
              handledCheckIds,
            } satisfies PrStatusCheckInvestigationResult
          }
          const rerunResult = yield* Effect.result(
            github.rerunWorkflowRun(repository, evidence.workflowRunId),
          )
          if (rerunResult._tag === "Failure") {
            if (isGitHubThrottledError(rerunResult.failure)) {
              yield* releaseThrottledAutomatedReviewRerun(permit.id)
              return yield* rerunResult.failure
            }
            const detail =
              "_tag" in rerunResult.failure &&
              "message" in rerunResult.failure &&
              typeof rerunResult.failure.message === "string" &&
              rerunResult.failure.message.trim() !== ""
                ? rerunResult.failure.message
                : "GitHub workflow rerun failed"
            return yield* new PrStatusChecksUnresolvedError({
              message: `Manual fixing may be required. ${detail}. Please fix or rerun the checks on GitHub, then click Retry checks.`,
            })
          }
          yield* completeAuthorizedReviewRerun(
            permit.id,
            context.workItemId,
            headSha,
          )
          yield* Effect.logInfo(
            "Status Check Handoff: authorized incomplete automated review recovery rerun",
            {
              workItemId: context.workItemId,
              headSha,
              workflowRunId: evidence.workflowRunId,
              signature: evidence.signature,
            },
          )
          return {
            _tag: "checks_triggered",
            handledCheckIds,
            checkStartAnchorRecorded: true,
          } satisfies PrStatusCheckInvestigationResult
        }
        // Positive or ambiguous evidence falls through to the Agent Turn path.
      }
    }
    const auth = yield* resolveAgentTurnForgeAuth(repository).pipe(
      Effect.mapError((cause) => {
        if (
          cause instanceof AgentTurnForgeCredentialMissingError ||
          cause instanceof InvalidCapturedAgentBackendError
        ) {
          return new PrStatusChecksContextError({ message: cause.message })
        }
        return new PrStatusChecksContextError({
          message: `Failed to resolve the repository ${forgeDisplayName(repository.forge)} credential`,
        })
      }),
    )
    let diagnostics: readonly PrStatusCheckDiagnostic[] = []
    if (redChecks.length > 0) {
      const logDirectory = `${worktreePath}/.ready-for-agent/status-check-logs`
      const diagnosticRequests = redChecks.map((check) => ({
        externalId: check.external_id,
        name: check.name,
      }))
      const mapDiagnosticError = (cause: unknown) =>
        new PrStatusChecksContextError({
          message:
            cause !== null &&
            typeof cause === "object" &&
            "message" in cause &&
            typeof cause.message === "string" &&
            cause.message.trim() !== ""
              ? `Failed to load PR Status Check diagnostics: ${cause.message}`
              : "Failed to load PR Status Check diagnostics for red PR Status Checks",
        })
      switch (repository.forge) {
        case "gitlab": {
          const gitlab = yield* GitLabService
          diagnostics = yield* gitlab
            .getPrStatusCheckDiagnostics(repository, diagnosticRequests, {
              logDirectory,
            })
            .pipe(Effect.mapError(mapDiagnosticError))
          break
        }
        case "azure-devops": {
          const azureDevOps = yield* AzureDevOpsService
          diagnostics = yield* azureDevOps
            .getPrStatusCheckDiagnostics(repository, diagnosticRequests, {
              logDirectory,
            })
            .pipe(Effect.mapError(mapDiagnosticError))
          break
        }
        case "github": {
          const github = yield* GitHubService
          diagnostics = yield* github
            .getPrStatusCheckDiagnostics(repository, diagnosticRequests, {
              logDirectory,
            })
            .pipe(
              Effect.mapError((cause) =>
                isGitHubThrottledError(cause)
                  ? cause
                  : mapDiagnosticError(cause),
              ),
            )
          break
        }
        default: {
          const _exhaustive: never = repository.forge
          return _exhaustive
        }
      }
    }
    const agentBackend = yield* AgentBackend
    const timeout =
      context.maxDuration ??
      DEFAULT_LIFECYCLE_MAX_DURATIONS.investigate_pr_status_checks
    // RERUN_REVIEW is a GitHub-only outcome (automated-review workflow rerun
    // authorization); GitLab and Azure DevOps never offer it.
    const missingOutcomeMessage =
      repository.forge === "github"
        ? `${agentBackendLabel(context.agentBackend)} did not report CHECKS_TRIGGERED, PROCESSED, RERUN_REVIEW, FAILED, or NEEDS_HUMAN`
        : `${agentBackendLabel(context.agentBackend)} did not report CHECKS_TRIGGERED, PROCESSED, FAILED, or NEEDS_HUMAN`

    const continueInvestigationTurn = (
      prompt: string,
      phase: string,
    ): Effect.Effect<
      { readonly assistantText: string },
      PrStatusChecksOpenCodeError
    > =>
      agentBackend
        .continueTurn({
          sessionId,
          prompt,
          cwd: worktreePath,
          model: context.model,
          thinkingLevel: context.thinkingLevel,
          timeout,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PrStatusChecksOpenCodeError({
                message: `${agentBackendLabel(context.agentBackend)} failed while investigating PR status checks (${phase})`,
                cause,
              }),
          ),
        )

    /**
     * Parse an Agent-reported Outcome from a work turn. Missing markers get one
     * classification-only fallback; malformed or non-final markers fail strictly.
     */
    const parseWithMissingOutcomeFallback = (
      assistantText: string,
      fallbackPhase: string,
    ): Effect.Effect<ParsedInvestigationResult, PrStatusChecksOpenCodeError> =>
      Effect.gen(function* () {
        let result = parseInvestigationResult(assistantText)
        if (result === null && !hasInvestigationResultLine(assistantText)) {
          const fallback = yield* continueInvestigationTurn(
            buildInvestigationOutcomeFallbackPrompt(repository.forge),
            fallbackPhase,
          )
          result = parseInvestigationResult(fallback.assistantText)
        }
        if (result === null) {
          return yield* new PrStatusChecksOpenCodeError({
            message: missingOutcomeMessage,
          })
        }
        return result
      })

    const work = yield* continueInvestigationTurn(
      [
        buildInvestigationWorkPrompt(repository.forge, unhandled, diagnostics),
        agentTurnForgeCredentialGuidance(
          repository,
          auth,
          ((): string => {
            switch (repository.forge) {
              case "github":
                return "GitHub CLI, API, commit, or push access"
              case "gitlab":
                return "GitLab API, commit, or push access"
              case "azure-devops":
                return "Azure DevOps REST API, commit, or push access"
              default: {
                const _exhaustive: never = repository.forge
                return _exhaustive
              }
            }
          })(),
        ),
        // Outcome contract must remain last so the final-line rule is not diluted.
        ...investigationOutcomeContractLines(repository.forge),
      ].join("\n"),
      "work",
    )
    let investigation = yield* parseWithMissingOutcomeFallback(
      work.assistantText,
      "outcome fallback",
    )
    if (typeof investigation !== "string" && investigation._tag === "failed") {
      const recovery = yield* continueInvestigationTurn(
        buildInvestigationRecoveryPrompt(
          investigation.reason,
          repository.forge,
        ),
        "recovery",
      )
      investigation = yield* parseWithMissingOutcomeFallback(
        recovery.assistantText,
        "recovery outcome fallback",
      )
    }

    const handledCheckIds = unhandled.map((check) => check.id)
    if (investigation === "processed") {
      return {
        _tag: "processed",
        handledCheckIds,
      } satisfies PrStatusCheckInvestigationResult
    }
    if (investigation === "checks_triggered") {
      return {
        _tag: "checks_triggered",
        handledCheckIds,
        checkStartAnchorRecorded: false,
      } satisfies PrStatusCheckInvestigationResult
    }
    if (
      typeof investigation !== "string" &&
      investigation._tag === "rerun_review"
    ) {
      // RERUN_REVIEW is a GitHub-only outcome; GitLab and Azure DevOps never
      // offer it, so any other forge reporting it is a harness/agent bug.
      if (repository.forge !== "github") {
        return yield* new PrStatusChecksOpenCodeError({
          message: `${agentBackendLabel(context.agentBackend)} reported the GitHub-only RERUN_REVIEW outcome for a ${forgeDisplayName(repository.forge)} Repository`,
        })
      }
      const workflowIdentity = formatAutomatedReviewWorkflowIdentity(
        investigation.workflowName,
        investigation.workflowRunId,
      )
      const github = yield* GitHubService
      const status = yield* github
        .getPullRequestCheckStatus(repository, branch)
        .pipe(
          Effect.mapError((cause) =>
            isGitHubThrottledError(cause)
              ? cause
              : new PrStatusChecksContextError({
                  message:
                    "message" in cause &&
                    typeof cause.message === "string" &&
                    cause.message.trim() !== ""
                      ? `Failed to resolve PR head for review rerun: ${cause.message}`
                      : "Failed to resolve PR head for review rerun",
                }),
          ),
        )
      const headSha = status.headSha
      if (headSha === null || headSha.trim() === "") {
        return yield* new PrStatusChecksUnresolvedError({
          message:
            "Manual fixing may be required. Could not resolve the pull request head SHA to authorize an automated review rerun. Please fix or rerun the checks on GitHub, then click Retry checks.",
        })
      }
      // Incomplete-tagged recovery already used this scope: do not allow
      // further agent RERUN_REVIEW past the one-retry incomplete cap.
      const incompleteTaggedUsed = yield* countAutomatedReviewReruns(
        context.workItemId,
        headSha,
        investigation.workflowRunId,
        INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
      )
      if (incompleteTaggedUsed >= AUTOMATED_REVIEW_INCOMPLETE_RERUN_LIMIT) {
        return {
          _tag: "needs_human",
          reason: automatedReviewIncompleteRerunLimitReason(workflowIdentity),
          handledCheckIds,
        } satisfies PrStatusCheckInvestigationResult
      }
      const permit = yield* reserveAutomatedReviewRerun(
        context.workItemId,
        headSha,
        investigation.workflowRunId,
        investigation.workflowName,
        { signature: null },
      )
      if (permit._tag === "exhausted") {
        return {
          _tag: "needs_human",
          reason: automatedReviewRerunLimitReason(workflowIdentity),
          handledCheckIds,
        } satisfies PrStatusCheckInvestigationResult
      }
      const rerunResult = yield* Effect.result(
        github.rerunWorkflowRun(repository, investigation.workflowRunId),
      )
      if (rerunResult._tag === "Failure") {
        if (isGitHubThrottledError(rerunResult.failure)) {
          yield* releaseThrottledAutomatedReviewRerun(permit.id)
          return yield* rerunResult.failure
        }
        // Reservation remains so a crash or indeterminate response cannot
        // unlock unbounded extra GitHub rerun calls after restart.
        const detail =
          "_tag" in rerunResult.failure &&
          "message" in rerunResult.failure &&
          typeof rerunResult.failure.message === "string" &&
          rerunResult.failure.message.trim() !== ""
            ? rerunResult.failure.message
            : "GitHub workflow rerun failed"
        return yield* new PrStatusChecksUnresolvedError({
          message: `Manual fixing may be required. ${detail}. Please fix or rerun the checks on GitHub, then click Retry checks.`,
        })
      }
      yield* completeAuthorizedReviewRerun(
        permit.id,
        context.workItemId,
        headSha,
      )
      return {
        _tag: "checks_triggered",
        handledCheckIds,
        checkStartAnchorRecorded: true,
      } satisfies PrStatusCheckInvestigationResult
    }
    if (
      typeof investigation !== "string" &&
      investigation._tag === "needs_human"
    ) {
      return {
        _tag: "needs_human",
        reason: investigation.reason,
        handledCheckIds,
      } satisfies PrStatusCheckInvestigationResult
    }
    const failedReason =
      typeof investigation !== "string" && investigation._tag === "failed"
        ? investigation.reason
        : "Unknown investigation outcome"
    const forgeLabel = forgeDisplayName(repository.forge)
    return yield* new PrStatusChecksUnresolvedError({
      message: `Manual fixing may be required. ${failedReason}. Please fix or rerun the checks on ${forgeLabel}, then click Retry checks.`,
    })
  })
