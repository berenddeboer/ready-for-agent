import { Clock, Data, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ulid } from "ulidx"
import { DbService } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type TerminalPrStatusCheck,
} from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"
import { workItemBranchName } from "./worktree-names.js"

export class PrStatusChecksContextError extends Data.TaggedError(
  "PrStatusChecksContextError",
)<{ readonly message: string }> {}

export class PrStatusChecksOpenCodeError extends Data.TaggedError(
  "PrStatusChecksOpenCodeError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export type PrStatusCheckResult =
  | "pending"
  | "no_checks"
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
    return status._tag satisfies PrStatusCheckResult
  })

const parseInvestigationResult = (
  output: string,
): "processed" | { readonly reason: string } | null => {
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
    return { reason: needsHuman[1].trim().slice(0, 500) }
  }
  return null
}

const buildInvestigationWorkPrompt = (
  checks: readonly ObservedPrStatusCheckRow[],
): string => {
  const redNames = checks
    .filter((check) => check.outcome === "red")
    .map((check) => check.name)
  const hasGreen = checks.some((check) => check.outcome === "green")
  const lines = [
    "Process the following PR Status Check results for the pull request on this worktree.",
  ]
  if (redNames.length > 0) {
    lines.push(
      "Diagnose and fix these failing checks when possible:",
      ...redNames.map((name) => `- ${name}`),
      "Use GitHub to inspect the failing checks and their logs. Fix the underlying problem when possible, verify the fix, commit it, and push it to the existing PR branch.",
    )
  }
  if (hasGreen) {
    lines.push(
      "One or more automated reviews may have completed. Inspect the latest pull-request comments, disregard reviews that are visibly still in progress, and address worthwhile completed feedback.",
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
    "or, only when the handoff cannot be processed autonomously or requires a human decision:",
    "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
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
    const opencode = yield* Opencode
    yield* opencode
      .continue({
        sessionId,
        prompt: [
          buildInvestigationWorkPrompt(unhandled),
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
    const verdict = yield* opencode
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
              message:
                "OpenCode failed while investigating PR status checks (verdict)",
              cause,
            }),
        ),
      )
    const investigation = parseInvestigationResult(verdict.assistantText)
    if (investigation === null) {
      return yield* new PrStatusChecksOpenCodeError({
        message: "OpenCode did not report PROCESSED or NEEDS_HUMAN",
      })
    }
    const handledCheckIds = unhandled.map((check) => check.id)
    return investigation === "processed"
      ? ({
          _tag: "processed",
          handledCheckIds,
        } satisfies PrStatusCheckInvestigationResult)
      : ({
          _tag: "needs_human",
          reason: investigation.reason,
          handledCheckIds,
        } satisfies PrStatusCheckInvestigationResult)
  })
