import { Data, Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
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

export type PrStatusCheckInvestigationResult =
  | { readonly _tag: "fixed" }
  | { readonly _tag: "needs_human"; readonly reason: string }

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

export const watchPrStatusChecks = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const { repository, branch } = yield* resolveContext(context)
    const github = yield* GitHubService
    const status = yield* github.getPullRequestCheckStatus(
      { owner: repository.githubOwner, name: repository.githubRepo },
      branch,
    )
    return status._tag satisfies PrStatusCheckResult
  })

const parseInvestigationResult = (
  output: string,
): PrStatusCheckInvestigationResult | null => {
  if (/READY_FOR_AGENT_RESULT:\s*FIXED\b/i.test(output)) {
    return { _tag: "fixed" }
  }
  const needsHuman = output.match(
    /READY_FOR_AGENT_RESULT:\s*NEEDS_HUMAN\s*:\s*([^\n]+)/i,
  )
  if (needsHuman?.[1] !== undefined && needsHuman[1].trim() !== "") {
    return { _tag: "needs_human", reason: needsHuman[1].trim().slice(0, 500) }
  }
  return null
}

export const investigatePrStatusChecks = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const { repository, worktreePath, sessionId } =
      yield* resolveContext(context)
    const keymaxxer = yield* KeymaxxerService
    const tokenName = yield* keymaxxer.findSecret({
      provider: "github",
      account: `${repository.githubOwner}/${repository.githubRepo}`,
    })
    if (tokenName === null) {
      return yield* new PrStatusChecksContextError({
        message: `No GitHub credential is configured for ${repository.githubOwner}/${repository.githubRepo}`,
      })
    }
    const prompt = [
      "Investigate the failing status checks on the pull request for this worktree.",
      "Use GitHub to inspect the failing checks and their logs. Fix the underlying problem when possible, verify the fix, commit it, and push it to the existing PR branch.",
      "Do not create or merge another pull request.",
      `Use Keymaxxer secret ${tokenName} via keymaxxer_run for any GitHub CLI or API access; never put secret values in the environment.`,
      "End your final response with exactly one machine-readable result line:",
      "READY_FOR_AGENT_RESULT: FIXED",
      "or, only when the failure cannot be fixed autonomously or requires a human decision:",
      "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
    ].join("\n")
    const opencode = yield* Opencode
    const result = yield* opencode
      .continue({
        sessionId,
        prompt,
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
              message: "OpenCode failed while investigating PR status checks",
              cause,
            }),
        ),
      )
    const investigation = parseInvestigationResult(result.assistantText)
    if (investigation === null) {
      return yield* new PrStatusChecksOpenCodeError({
        message: "OpenCode did not report FIXED or NEEDS_HUMAN",
      })
    }
    return investigation
  })
