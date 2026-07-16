import { Data, Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

export class ResolvePrMergeConflictContextError extends Data.TaggedError(
  "ResolvePrMergeConflictContextError",
)<{ readonly message: string }> {}

export class ResolvePrMergeConflictOpenCodeError extends Data.TaggedError(
  "ResolvePrMergeConflictOpenCodeError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export type ResolvePrMergeConflictResult =
  | { readonly _tag: "processed" }
  | { readonly _tag: "needs_human"; readonly reason: string }

const parseResult = (
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
  return needsHuman?.[1] === undefined || needsHuman[1].trim() === ""
    ? null
    : { reason: needsHuman[1].trim().slice(0, 500) }
}

const workPrompt = (tokenName: string): string =>
  [
    "Resolve the merge conflict on the existing pull request for this worktree by rebasing its branch.",
    "Fetch origin and inspect the pull request to determine its current base branch (normally the repository default branch).",
    "Incorporate every current remote commit from the pull-request branch into the local branch before rebasing onto the latest remote base branch. Do not drop another contributor's commits.",
    "Resolve the rebase conflicts, then run the appropriate verification for the repository.",
    "Push the rebased pull-request branch with --force-with-lease. Do not use an unconditional force push.",
    "If the lease is rejected, refetch, incorporate the updated remote PR branch, rebase onto the current remote base again, verify, and retry the --force-with-lease push exactly once. If that second push cannot safely succeed, stop and report that human intervention is needed in the follow-up verdict turn.",
    "Do not create or merge another pull request and do not do unrelated work.",
    `Use Keymaxxer secret ${tokenName} via keymaxxer_run for any GitHub CLI, API, fetch, or push access; never put secret values in the environment.`,
    "When finished, stop. Do not print a READY_FOR_AGENT_RESULT line yet; a follow-up turn will ask for the verdict.",
  ].join("\n")

const verdictPrompt = (): string =>
  [
    "Based only on the PR merge-conflict resolution work you just did in this session, report the outcome.",
    "Do not make further code changes unless required to answer accurately.",
    "Reply with exactly one machine-readable result line (and optional brief prose before it):",
    "READY_FOR_AGENT_RESULT: PROCESSED",
    "or, only when the conflict could not be resolved and pushed autonomously or requires a human decision:",
    "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
  ].join("\n")

export const resolvePrMergeConflict = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    if (context.worktreePath === null || context.worktreePath.trim() === "") {
      return yield* new ResolvePrMergeConflictContextError({
        message: "Resolve PR Merge Conflict requires a persisted worktree path",
      })
    }
    if (context.sessionId === null || context.sessionId.trim() === "") {
      return yield* new ResolvePrMergeConflictContextError({
        message:
          "Resolve PR Merge Conflict requires the Implement OpenCode Session",
      })
    }
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new ResolvePrMergeConflictContextError({
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    const keymaxxer = yield* KeymaxxerService
    const tokenName = yield* keymaxxer.findSecret({
      provider: "github",
      account: `${repository.githubOwner}/${repository.githubRepo}`,
    })
    if (tokenName === null) {
      return yield* new ResolvePrMergeConflictContextError({
        message: `No GitHub credential is configured for ${repository.githubOwner}/${repository.githubRepo}`,
      })
    }
    const opencode = yield* Opencode
    const timeout =
      context.maxDuration ??
      DEFAULT_LIFECYCLE_MAX_DURATIONS.resolve_pr_merge_conflict
    yield* opencode
      .continue({
        sessionId: context.sessionId,
        prompt: workPrompt(tokenName),
        cwd: context.worktreePath,
        model: context.model,
        variant: context.variant,
        timeout,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ResolvePrMergeConflictOpenCodeError({
              message:
                "OpenCode failed while resolving PR merge conflict (work)",
              cause,
            }),
        ),
      )
    const verdict = yield* opencode
      .continue({
        sessionId: context.sessionId,
        prompt: verdictPrompt(),
        cwd: context.worktreePath,
        model: context.model,
        variant: context.variant,
        timeout,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ResolvePrMergeConflictOpenCodeError({
              message:
                "OpenCode failed while resolving PR merge conflict (verdict)",
              cause,
            }),
        ),
      )
    const result = parseResult(verdict.assistantText)
    if (result === null) {
      return yield* new ResolvePrMergeConflictOpenCodeError({
        message: "OpenCode did not report PROCESSED or NEEDS_HUMAN",
      })
    }
    return result === "processed"
      ? ({ _tag: "processed" } satisfies ResolvePrMergeConflictResult)
      : ({
          _tag: "needs_human",
          reason: result.reason,
        } satisfies ResolvePrMergeConflictResult)
  })
