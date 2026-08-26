import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { DbService } from "@ready-for-agent/db-service"
import {
  type AgentTurnForgeAuth,
  AgentTurnForgeCredentialMissingError,
  type AgentTurnForgeRepository,
  InvalidCapturedAgentBackendError,
  agentTurnForgeCredentialGuidance,
  forgeDisplayName,
  resolveAgentTurnForgeAuth,
} from "./agent-turn-forge-auth.js"
import {
  ImplementForgeCredentialError,
  ImplementInvalidWorktreeContextError,
  ImplementIssueContextMissingError,
  ImplementOpenCodeError,
  ImplementRepositoryNotFoundError,
  ImplementWorktreeContextMissingError,
} from "./implement-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"
import { workItemAttachmentDirectory } from "./work-item-attachment-directory.js"

const persistSessionIdMidRun = (
  workItemId: string,
  sessionId: string,
  repositoryId: string,
): Effect.Effect<void, never, SqlClient.SqlClient | DbService> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const db = yield* DbService
    const now = Date.now()
    const rows = (yield* sql.unsafe(
      `UPDATE work_item
       SET session_id = ?, updated_at = ?
       WHERE id = ?
         AND (session_id IS NULL OR session_id = '' OR session_id = ?)
       RETURNING id`,
      [sessionId, now, workItemId, sessionId],
    )) as readonly { readonly id: string }[]
    if (rows[0]) {
      yield* db.notifyWorkItemsChanged(repositoryId)
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Failed to persist Agent session id mid-implement", {
        workItemId,
        sessionId,
        error,
      }),
    ),
    Effect.asVoid,
  )

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new ImplementWorktreeContextMissingError({
        workItemId: context.workItemId,
        message:
          "Implement requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new ImplementInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new ImplementInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path is not a directory: ${worktreePath}`,
      })
    }

    return worktreePath
  })

const resolveRepository = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new ImplementRepositoryNotFoundError({
        repositoryId: context.repositoryId,
        message: `Repository not found for Implement: ${context.repositoryId}`,
      })
    }
    return repository
  })

const resolveIssueNumber = (context: LifecycleStepContext) => {
  if (!Number.isInteger(context.issueNumber) || context.issueNumber <= 0) {
    return Effect.fail(
      new ImplementIssueContextMissingError({
        workItemId: context.workItemId,
        message: "Implement requires a positive issue number on the Work Item",
      }),
    )
  }
  return Effect.succeed(context.issueNumber)
}

/** Per-Forge access scope for the Implement credential guidance line. */
const implementAccessScope = (repository: AgentTurnForgeRepository): string => {
  switch (repository.forge) {
    case "gitlab":
      return "read of the GitLab Issue"
    case "azure-devops":
      return "read of the Azure DevOps Issue"
    case "github":
      return "read of the GitHub Issue"
    default: {
      const _exhaustive: never = repository.forge
      return _exhaustive
    }
  }
}

const implementTheIssuePromptLine =
  "Do not merely propose a plan; implement the requested changes in this worktree for that exact issue."

/** Implement may inspect the tracker Issue; the harness closes it after merge. */
const trackerIssueStayOpenPromptLine = (
  forge: AgentTurnForgeRepository["forge"],
): string => {
  const leaveOpen =
    "Leave the tracker Issue open; the harness closes it after merge."
  switch (forge) {
    case "github":
      return `${leaveOpen} Do not close, complete, or change its state, including \`gh issue close\`.`
    case "gitlab":
      return `${leaveOpen} Do not close, complete, or change its state, including \`glab issue close\` or an API state change.`
    case "azure-devops":
      return `${leaveOpen} You may GET the Work Item to inspect it. Do not close, complete, or change its state, including PATCH of \`System.State\`.`
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

const visualEvidencePromptLines = (workItemId: string): readonly string[] => {
  const attachmentDirectory = workItemAttachmentDirectory({ workItemId })
  return [
    `Work Item attachment directory: ${attachmentDirectory}`,
    "If the Issue asks for visual PR evidence, capture a genuine before-shot before any repository change, then after/production into that directory. Do not open or edit a pull request to attach images.",
  ]
}

/**
 * Issue identity plus Forge name in the prompt. GitHub stays ambient (no host,
 * no credential line); GitLab and Azure DevOps name the host and carry the
 * Forge-selected credential guidance.
 */
const buildImplementPrompt = (
  repository: AgentTurnForgeRepository,
  issueNumber: number,
  workItemId: string,
  forgeAuth: AgentTurnForgeAuth,
) =>
  repository.forge === "github"
    ? [
        `Implement GitHub issue ${repository.projectPath}#${issueNumber}.`,
        "Inspect the current GitHub Issue and this Repository's agent/project instructions.",
        trackerIssueStayOpenPromptLine(repository.forge),
        "Make the implementation in this worktree and run appropriate verification.",
        implementTheIssuePromptLine,
        ...visualEvidencePromptLines(workItemId),
      ].join("\n")
    : [
        `Implement ${forgeDisplayName(repository.forge)} issue ${repository.projectPath}#${issueNumber} on ${repository.forgeHost}.`,
        `Inspect the current ${forgeDisplayName(repository.forge)} Issue and this Repository's agent/project instructions.`,
        agentTurnForgeCredentialGuidance(
          repository,
          forgeAuth,
          implementAccessScope(repository),
        ),
        trackerIssueStayOpenPromptLine(repository.forge),
        "Make the implementation in this worktree and run appropriate verification.",
        implementTheIssuePromptLine,
        ...visualEvidencePromptLines(workItemId),
      ].join("\n")

const buildContinueImplementPrompt = (
  repository: AgentTurnForgeRepository,
  issueNumber: number,
  workItemId: string,
  forgeAuth: AgentTurnForgeAuth,
) =>
  repository.forge === "github"
    ? [
        `Continue implementing GitHub issue ${repository.projectPath}#${issueNumber}.`,
        "A previous Implement attempt was interrupted or failed; resume from the existing session and worktree state.",
        "Inspect the current GitHub Issue, this Repository's agent/project instructions, and any partial work already present.",
        trackerIssueStayOpenPromptLine(repository.forge),
        "Finish the implementation in this worktree and run appropriate verification.",
        implementTheIssuePromptLine,
        ...visualEvidencePromptLines(workItemId),
      ].join("\n")
    : [
        `Continue implementing ${forgeDisplayName(repository.forge)} issue ${repository.projectPath}#${issueNumber} on ${repository.forgeHost}.`,
        "A previous Implement attempt was interrupted or failed; resume from the existing session and worktree state.",
        `Inspect the current ${forgeDisplayName(repository.forge)} Issue, this Repository's agent/project instructions, and any partial work already present.`,
        agentTurnForgeCredentialGuidance(
          repository,
          forgeAuth,
          implementAccessScope(repository),
        ),
        trackerIssueStayOpenPromptLine(repository.forge),
        "Finish the implementation in this worktree and run appropriate verification.",
        implementTheIssuePromptLine,
        ...visualEvidencePromptLines(workItemId),
      ].join("\n")

const priorSessionId = (context: LifecycleStepContext): string | null => {
  const sessionId = context.sessionId
  if (sessionId === null || sessionId.trim() === "") {
    return null
  }
  return sessionId
}

/**
 * Production Implement Lifecycle Step.
 * Starts a fresh OpenCode Session in the Work Item worktree when none exists,
 * or continues the prior Session when `session_id` is already set (Retry after
 * interrupt or failed Build). Fresh start after delete/reset has no session id.
 */
export const implement = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const repository = yield* resolveRepository(context)
    const issueNumber = yield* resolveIssueNumber(context)
    const forgeAuth = yield* resolveAgentTurnForgeAuth(repository).pipe(
      Effect.mapError((cause) => {
        if (
          cause instanceof AgentTurnForgeCredentialMissingError ||
          cause instanceof InvalidCapturedAgentBackendError
        ) {
          return new ImplementForgeCredentialError({
            repositoryId: context.repositoryId,
            message: cause.message,
          })
        }
        return new ImplementForgeCredentialError({
          repositoryId: context.repositoryId,
          message: `Failed to resolve the repository ${forgeDisplayName(repository.forge)} credential`,
          cause,
        })
      }),
    )

    const existingSessionId = priorSessionId(context)
    const prompt =
      existingSessionId === null
        ? buildImplementPrompt(
            repository,
            issueNumber,
            context.workItemId,
            forgeAuth,
          )
        : buildContinueImplementPrompt(
            repository,
            issueNumber,
            context.workItemId,
            forgeAuth,
          )

    const agentBackend = yield* AgentBackend
    const sql = yield* SqlClient.SqlClient
    const db = yield* DbService
    const onSessionId = (sessionId: string) =>
      persistSessionIdMidRun(
        context.workItemId,
        sessionId,
        context.repositoryId,
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(DbService, db),
      )

    const run =
      existingSessionId === null
        ? agentBackend.startTurn({
            prompt,
            cwd: worktreePath,
            model: context.model,
            thinkingLevel: context.thinkingLevel,
            timeout:
              context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.implement,
            onSessionId,
          })
        : agentBackend.continueTurn({
            sessionId: existingSessionId,
            prompt,
            cwd: worktreePath,
            model: context.model,
            thinkingLevel: context.thinkingLevel,
            timeout:
              context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.implement,
            onSessionId,
          })

    const result = yield* run.pipe(
      Effect.mapError(
        (cause) =>
          new ImplementOpenCodeError({
            message: `${agentBackendLabel(context.agentBackend)} failed to implement the Work Item issue`,
            worktreePath,
            cause,
          }),
      ),
    )

    if (result.sessionId.trim() === "") {
      return yield* new ImplementOpenCodeError({
        message: `${agentBackendLabel(context.agentBackend)} completed without returning a Session ID`,
        worktreePath,
      })
    }

    return result.sessionId
  })
