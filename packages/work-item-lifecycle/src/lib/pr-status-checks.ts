import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ulid } from "ulidx"
import { DbService } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type PrStatusCheckDiagnostic,
  type TerminalPrStatusCheck,
} from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"
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

export type PrStatusCheckResult =
  | "pending"
  | {
      readonly _tag: "no_checks"
      readonly headPushedAt: Date | null
    }
  | "succeeded"
  | "failed"
  | "closed"
  | "handoff_needed"
  | {
      readonly _tag: "conflict"
      readonly retiredCheckIds: readonly string[]
    }

export type PrStatusCheckInvestigationResult =
  | { readonly _tag: "processed"; readonly handledCheckIds: readonly string[] }
  | {
      readonly _tag: "needs_human"
      readonly reason: string
      readonly handledCheckIds: readonly string[]
    }

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
        message: "PR status checks require the Implement OpenCode Session",
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
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
      githubIssueNumber: context.githubIssueNumber,
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

export const watchPrStatusChecks = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const { repository, branch } = yield* resolveContext(context)
    const github = yield* GitHubService
    const status = yield* github.getPullRequestCheckStatus(
      { owner: repository.githubOwner, name: repository.githubRepo },
      branch,
    )
    const terminalChecks =
      status._tag === "pending" ||
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
      return "closed" satisfies PrStatusCheckResult
    }
    if (status.mergeability === "conflicting") {
      return {
        _tag: "conflict",
        retiredCheckIds: unhandled.map((check) => check.id),
      } satisfies PrStatusCheckResult
    }
    if (status.mergeability === "unknown") {
      return "pending" satisfies PrStatusCheckResult
    }
    if (unhandled.length > 0) {
      return "handoff_needed" satisfies PrStatusCheckResult
    }
    if (status._tag === "no_checks") {
      return {
        _tag: "no_checks",
        headPushedAt: status.headPushedAt,
      } satisfies PrStatusCheckResult
    }
    return status._tag satisfies PrStatusCheckResult
  })

type ParsedInvestigationResult =
  | "processed"
  | { readonly _tag: "needs_human"; readonly reason: string }
  | { readonly _tag: "failed"; readonly reason: string }

const parseInvestigationResult = (
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
  const needsHuman = finalLine.match(
    /^READY_FOR_AGENT_RESULT:\s*NEEDS_HUMAN\s*:\s*(.+)$/i,
  )
  if (needsHuman?.[1] !== undefined && needsHuman[1].trim() !== "") {
    return {
      _tag: "needs_human",
      reason: needsHuman[1].trim().slice(0, 500),
    }
  }
  const failed = finalLine.match(
    /^READY_FOR_AGENT_RESULT:\s*FAILED\s*:\s*(.+)$/i,
  )
  if (failed?.[1] !== undefined && failed[1].trim() !== "") {
    return {
      _tag: "failed",
      reason: failed[1].trim().slice(0, 500),
    }
  }
  return null
}

const sourceLabel = (externalId: string): string => {
  if (externalId.startsWith("actions-job:")) {
    return "Actions job"
  }
  if (externalId.startsWith("status:")) {
    return "commit status"
  }
  return "unknown source"
}

const formatRedCheckLine = (check: ObservedPrStatusCheckRow): string =>
  `- ${check.name} (external id: ${check.external_id}, source: ${sourceLabel(check.external_id)})`

const formatDiagnosticBlock = (diagnostic: PrStatusCheckDiagnostic): string => {
  const header = `### ${diagnostic.name} (${diagnostic.externalId}, source: ${diagnostic.source})`
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
      "```",
      diagnostic.logFetch.excerpt,
      "```",
    ].join("\n")
  }
  return [
    header,
    urlLine,
    `Log fetch unavailable: ${diagnostic.logFetch.reason}`,
  ].join("\n")
}

const buildInvestigationWorkPrompt = (
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
      "Fine-grained GitHub PATs often cannot use the Checks API; HTTP 403 on Checks endpoints is expected and is not a credential failure by itself. Prefer Actions job logs for external ids of the form actions-job:<id>.",
      "When calling `gh api` with query parameters on GET endpoints, pass `--method GET` with `-f` (or use a GET-safe invocation). Bare `-f` defaults to POST and can produce misleading 404 responses.",
      "For transient infrastructure failures (for example GitHub 503, runner outages, or flaky network during the check), restart the failed checks when appropriate so new executions can run before concluding the handoff cannot progress.",
    )
    if (diagnostics.length > 0) {
      lines.push(
        "Harness diagnostics for the red checks follow. Use these artifacts first; only call GitHub for additional detail if needed.",
        ...diagnostics.map(formatDiagnosticBlock),
      )
    }
    lines.push(
      "Fix the underlying problem when possible, verify the fix, commit it, and push it to the existing PR branch.",
    )
  }
  if (hasGreen) {
    lines.push(
      "One or more automated reviews may have completed, but an automated reviewer can stop semantically incomplete even when GitHub reports its check and workflow as successful. Inspect the latest relevant automated-review comment and its linked review run before deciding what to do.",
      "Use provider-specific progress artifacts as evidence of incompleteness. Strong evidence can include a finished banner combined with unchecked substantive review tasks, a remaining working spinner, and no final findings or synthesis. Do not treat arbitrary Markdown checkboxes in unrelated pull-request comments as an automated-review progress list.",
      "Correlate the latest relevant comment with the latest relevant run attempt. Do not rerun because of a stale incomplete comment when a newer attempt completed its review successfully.",
      "If the linked latest review run is still active, leave it alone and do not start a duplicate. If that run is terminal and its latest relevant comment remains visibly incomplete, rerun the whole review workflow even when the run concluded success. For a technically successful run, do not use a failed-jobs-only rerun because GitHub considers no job failed.",
      "Rerunning a terminal incomplete review is required recovery, not optional feedback handling. If it cannot be restarted autonomously, report NEEDS_HUMAN with a concise reason in the verdict turn.",
      "For a genuinely completed latest review, address worthwhile feedback. A completed review with no worthwhile feedback still needs no changes or rerun.",
      "If review feedback requires changes, verify them, commit them, and push the commit to the existing PR branch.",
    )
  }
  lines.push(
    "If you create a commit during this handoff, after pushing it post one comment on the existing pull request that includes the commit SHA, summarizes the changes and verification, identifies the review feedback addressed, and lists any review feedback declined with a brief reason (or says none was declined).",
    "Do not post this summary comment when you did not create a commit.",
    "Do not create or merge another pull request.",
    "When finished, stop. Do not print a READY_FOR_AGENT_RESULT line yet; a follow-up turn will ask for the verdict.",
  )
  return lines.join("\n")
}

const buildInvestigationVerdictPrompt = (): string =>
  [
    "Based only on the PR status-check work you just did in this session, report the outcome.",
    "Do not make further code changes unless required to answer accurately.",
    "Reply with exactly one machine-readable result line (and optional brief prose before it):",
    "READY_FOR_AGENT_RESULT: PROCESSED",
    "Use PROCESSED only when you took an action expected to produce new check executions or a replacement execution (for example a commit and push, restarting failed checks, or rerunning a terminal incomplete reviewer), or when the handoff was green-only feedback from a genuinely completed review with nothing to address.",
    "Rerunning the whole workflow for a terminal incomplete review creates a replacement execution and supports PROCESSED. A terminal incomplete review is not green-only completed feedback with nothing to address, even when GitHub reported success.",
    "If this handoff contained red checks and you made no commit, push, check restart, or other action capable of producing a new execution, leaving the PR red, you must not report PROCESSED. Report:",
    "READY_FOR_AGENT_RESULT: FAILED: <concise reason>",
    "or, only when the handoff cannot be processed autonomously or requires a human decision:",
    "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
  ].join("\n")

const buildInvestigationRecoveryPrompt = (reason: string): string =>
  [
    "Make one focused recovery attempt to get the pull request out of its red state.",
    `Your previous verdict was FAILED: ${reason}`,
    "Re-check the current pull request and try any safe action that can produce a replacement check execution, including restarting an appropriate failed workflow.",
    "Do not create an empty or no-op commit merely to restart checks.",
    "When finished, stop. Do not print a READY_FOR_AGENT_RESULT line yet; a follow-up turn will ask for the verdict.",
  ].join("\n")

export const investigatePrStatusChecks = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const { repository, worktreePath, sessionId } =
      yield* resolveContext(context)
    const unhandled = yield* listUnhandledChecks(context.workItemId)
    if (unhandled.length === 0) {
      return {
        _tag: "processed",
        handledCheckIds: [],
      } satisfies PrStatusCheckInvestigationResult
    }
    const keymaxxer = yield* KeymaxxerService
    const tokenName =
      keymaxxer.enabled === false
        ? undefined
        : yield* keymaxxer.findSecret({
            provider: "github",
            account: `${repository.githubOwner}/${repository.githubRepo}`,
          })
    if (tokenName === null) {
      return yield* new PrStatusChecksContextError({
        message: `No GitHub credential is configured for ${repository.githubOwner}/${repository.githubRepo}`,
      })
    }
    const redChecks = unhandled.filter((check) => check.outcome === "red")
    let diagnostics: readonly PrStatusCheckDiagnostic[] = []
    if (redChecks.length > 0) {
      const github = yield* GitHubService
      const logDirectory = `${worktreePath}/.ready-for-agent/status-check-logs`
      diagnostics = yield* github
        .getPrStatusCheckDiagnostics(
          { owner: repository.githubOwner, name: repository.githubRepo },
          redChecks.map((check) => ({
            externalId: check.external_id,
            name: check.name,
          })),
          { logDirectory },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new PrStatusChecksContextError({
                message:
                  "message" in cause &&
                  typeof cause.message === "string" &&
                  cause.message.trim() !== ""
                    ? `Failed to load PR Status Check diagnostics: ${cause.message}`
                    : "Failed to load PR Status Check diagnostics for red PR Status Checks",
              }),
          ),
        )
    }
    const opencode = yield* Opencode
    yield* opencode
      .continue({
        sessionId,
        prompt: [
          buildInvestigationWorkPrompt(unhandled, diagnostics),
          ...(tokenName === undefined
            ? []
            : [
                `Use Keymaxxer secret ${tokenName} via keymaxxer_run for any GitHub CLI, API, commit, or push access; never put secret values in the environment.`,
              ]),
        ].join("\n"),
        cwd: worktreePath,
        model: context.model,
        variant: context.variant,
        timeout:
          context.maxDuration ??
          DEFAULT_LIFECYCLE_MAX_DURATIONS.investigate_pr_status_checks,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PrStatusChecksOpenCodeError({
              message:
                "OpenCode failed while investigating PR status checks (work)",
              cause,
            }),
        ),
      )
    const requestVerdict = (phase: string) =>
      opencode
        .continue({
          sessionId,
          prompt: buildInvestigationVerdictPrompt(),
          cwd: worktreePath,
          model: context.model,
          variant: context.variant,
          timeout:
            context.maxDuration ??
            DEFAULT_LIFECYCLE_MAX_DURATIONS.investigate_pr_status_checks,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PrStatusChecksOpenCodeError({
                message: `OpenCode failed while investigating PR status checks (${phase})`,
                cause,
              }),
          ),
          Effect.flatMap(({ assistantText }) => {
            const result = parseInvestigationResult(assistantText)
            return result === null
              ? Effect.fail(
                  new PrStatusChecksOpenCodeError({
                    message:
                      "OpenCode did not report PROCESSED, FAILED, or NEEDS_HUMAN",
                  }),
                )
              : Effect.succeed(result)
          }),
        )

    let investigation = yield* requestVerdict("verdict")
    if (investigation !== "processed" && investigation._tag === "failed") {
      yield* opencode
        .continue({
          sessionId,
          prompt: buildInvestigationRecoveryPrompt(investigation.reason),
          cwd: worktreePath,
          model: context.model,
          variant: context.variant,
          timeout:
            context.maxDuration ??
            DEFAULT_LIFECYCLE_MAX_DURATIONS.investigate_pr_status_checks,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PrStatusChecksOpenCodeError({
                message:
                  "OpenCode failed while investigating PR status checks (recovery)",
                cause,
              }),
          ),
        )
      investigation = yield* requestVerdict("recovery verdict")
    }

    const handledCheckIds = unhandled.map((check) => check.id)
    if (investigation === "processed") {
      return {
        _tag: "processed",
        handledCheckIds,
      } satisfies PrStatusCheckInvestigationResult
    }
    if (investigation._tag === "needs_human") {
      return {
        _tag: "needs_human",
        reason: investigation.reason,
        handledCheckIds,
      } satisfies PrStatusCheckInvestigationResult
    }
    return yield* new PrStatusChecksUnresolvedError({
      message: `Manual fixing may be required. ${investigation.reason}. Please fix or rerun the checks on GitHub, then click Retry checks.`,
    })
  })
