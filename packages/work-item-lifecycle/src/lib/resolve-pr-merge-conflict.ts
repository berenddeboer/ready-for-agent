import { Effect, Schema } from "effect"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { DbService } from "@ready-for-agent/db-service"
import {
  type AgentTurnGitHubAuth,
  AgentTurnGitHubCredentialMissingError,
  InvalidCapturedAgentBackendError,
  agentTurnGitHubCredentialGuidance,
  resolveAgentTurnGitHubAuth,
} from "./agent-turn-github-auth.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

export class ResolvePrMergeConflictContextError extends Schema.TaggedErrorClass<ResolvePrMergeConflictContextError>()(
  "ResolvePrMergeConflictContextError",
  {
    message: Schema.String,
  },
) {}

export class ResolvePrMergeConflictOpenCodeError extends Schema.TaggedErrorClass<ResolvePrMergeConflictOpenCodeError>()(
  "ResolvePrMergeConflictOpenCodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

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

const hasResultLine = (output: string): boolean =>
  output
    .split("\n")
    .some((line) => /^READY_FOR_AGENT_RESULT:/i.test(line.trim()))

const mergeConflictOutcomeContractLines = (): readonly string[] => [
  "You may include a concise work and verification summary before the result line.",
  "End your final response with exactly one machine-readable result line:",
  "READY_FOR_AGENT_RESULT: PROCESSED",
  "or, only when the conflict could not be resolved and pushed autonomously or requires a human decision:",
  "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <concise reason>",
]

const workPrompt = (auth: AgentTurnGitHubAuth): string =>
  [
    "Resolve the merge conflict on the existing pull request for this worktree by rebasing its branch.",
    "Fetch origin and inspect the pull request to determine its current base branch (normally the repository default branch).",
    "Incorporate every current remote commit from the pull-request branch into the local branch before rebasing onto the latest remote base branch. Do not drop another contributor's commits.",
    "Resolve the rebase conflicts, then run the appropriate verification for the repository.",
    "Push the rebased pull-request branch with --force-with-lease. Do not use an unconditional force push.",
    "If the lease is rejected, refetch, incorporate the updated remote PR branch, rebase onto the current remote base again, verify, and retry the --force-with-lease push exactly once. If that second push cannot safely succeed, stop and report human intervention is needed via the NEEDS_HUMAN outcome.",
    "Do not create or merge another pull request and do not do unrelated work.",
    agentTurnGitHubCredentialGuidance(
      auth,
      "GitHub CLI, API, fetch, or push access",
    ),
    ...mergeConflictOutcomeContractLines(),
  ].join("\n")

const outcomeFallbackPrompt = (): string =>
  [
    "Based only on the PR merge-conflict resolution work you just did in this session, report the outcome.",
    "Do not make further code changes unless required to answer accurately.",
    ...mergeConflictOutcomeContractLines(),
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
          "Resolve PR Merge Conflict requires a Session ID persisted by a successful Implement Step Run",
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
    const auth = yield* resolveAgentTurnGitHubAuth({
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
    }).pipe(
      Effect.mapError((cause) => {
        if (
          cause instanceof AgentTurnGitHubCredentialMissingError ||
          cause instanceof InvalidCapturedAgentBackendError
        ) {
          return new ResolvePrMergeConflictContextError({
            message: cause.message,
          })
        }
        return new ResolvePrMergeConflictContextError({
          message: "Failed to resolve the repository GitHub credential",
        })
      }),
    )
    const agentBackend = yield* AgentBackend
    const timeout =
      context.maxDuration ??
      DEFAULT_LIFECYCLE_MAX_DURATIONS.resolve_pr_merge_conflict
    const work = yield* agentBackend
      .continueTurn({
        sessionId: context.sessionId,
        prompt: workPrompt(auth),
        cwd: context.worktreePath,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        timeout,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ResolvePrMergeConflictOpenCodeError({
              message: `${agentBackendLabel(context.agentBackend)} failed while resolving PR merge conflict (work)`,
              cause,
            }),
        ),
      )
    let result = parseResult(work.assistantText)
    if (result === null && !hasResultLine(work.assistantText)) {
      const fallback = yield* agentBackend
        .continueTurn({
          sessionId: context.sessionId,
          prompt: outcomeFallbackPrompt(),
          cwd: context.worktreePath,
          model: context.model,
          thinkingLevel: context.thinkingLevel,
          timeout,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ResolvePrMergeConflictOpenCodeError({
                message: `${agentBackendLabel(context.agentBackend)} failed while resolving PR merge conflict (outcome fallback)`,
                cause,
              }),
          ),
        )
      result = parseResult(fallback.assistantText)
    }
    if (result === null) {
      return yield* new ResolvePrMergeConflictOpenCodeError({
        message: `${agentBackendLabel(context.agentBackend)} did not report PROCESSED or NEEDS_HUMAN`,
      })
    }
    return result === "processed"
      ? ({ _tag: "processed" } satisfies ResolvePrMergeConflictResult)
      : ({
          _tag: "needs_human",
          reason: result.reason,
        } satisfies ResolvePrMergeConflictResult)
  })
