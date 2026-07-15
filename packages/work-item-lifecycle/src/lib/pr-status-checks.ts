import { Data, Duration, Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  buildRunArgs,
  makeOpencodeEnvironment,
} from "@ready-for-agent/opencode"
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

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

const assistantText = (stdout: string): string =>
  stdout
    .split("\n")
    .flatMap((line) => {
      try {
        const event: unknown = JSON.parse(line)
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "text" &&
          "text" in event &&
          typeof event.text === "string"
        ) {
          return [event.text]
        }
      } catch {
        return []
      }
      return []
    })
    .join("\n")

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
      "End your final response with exactly one machine-readable result line:",
      "READY_FOR_AGENT_RESULT: FIXED",
      "or, only when the failure cannot be fixed autonomously or requires a human decision:",
      "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
    ].join("\n")
    const args = buildRunArgs({
      prompt,
      cwd: worktreePath,
      model: context.model,
      variant: context.variant,
      sessionId,
    })
    const environment = makeOpencodeEnvironment()
    const command = `${[
      `GH_TOKEN="$${tokenName}"`,
      `GITHUB_TOKEN="$${tokenName}"`,
      `OPENCODE_CONFIG_CONTENT=${shellQuote(environment.OPENCODE_CONFIG_CONTENT)}`,
      shellQuote("opencode"),
      ...args.map(shellQuote),
    ].join(" ")} </dev/null`
    const result = yield* keymaxxer
      .runWithSecrets({
        command,
        cwd: worktreePath,
        secrets: [tokenName],
        timeoutMs: Duration.toMillis(
          context.maxDuration ??
            DEFAULT_LIFECYCLE_MAX_DURATIONS.investigate_pr_status_checks,
        ),
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
    if (result.exitCode !== 0) {
      return yield* new PrStatusChecksOpenCodeError({
        message: "OpenCode failed while investigating PR status checks",
      })
    }
    const investigation = parseInvestigationResult(assistantText(result.stdout))
    if (investigation === null) {
      return yield* new PrStatusChecksOpenCodeError({
        message: "OpenCode did not report FIXED or NEEDS_HUMAN",
      })
    }
    return investigation
  })
