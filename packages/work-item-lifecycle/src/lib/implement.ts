import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { DbService } from "@ready-for-agent/db-service"
import {
  ImplementInvalidWorktreeContextError,
  ImplementIssueContextMissingError,
  ImplementOpenCodeError,
  ImplementRepositoryNotFoundError,
  ImplementWorktreeContextMissingError,
} from "./implement-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

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
      Effect.logWarning("Failed to persist OpenCode session id mid-implement", {
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
  if (
    !Number.isInteger(context.githubIssueNumber) ||
    context.githubIssueNumber <= 0
  ) {
    return Effect.fail(
      new ImplementIssueContextMissingError({
        workItemId: context.workItemId,
        message:
          "Implement requires a positive GitHub issue number on the Work Item",
      }),
    )
  }
  return Effect.succeed(context.githubIssueNumber)
}

const buildImplementPrompt = (
  githubOwner: string,
  githubRepo: string,
  githubIssueNumber: number,
) =>
  [
    `Implement GitHub issue ${githubOwner}/${githubRepo}#${githubIssueNumber}.`,
    "Inspect the current GitHub Issue and this Repository's agent/project instructions.",
    "Make the implementation in this worktree and run appropriate verification.",
    "Do not merely propose a plan; complete the implementation work for that exact issue.",
  ].join("\n")

const buildContinueImplementPrompt = (
  githubOwner: string,
  githubRepo: string,
  githubIssueNumber: number,
) =>
  [
    `Continue implementing GitHub issue ${githubOwner}/${githubRepo}#${githubIssueNumber}.`,
    "A previous Implement attempt was interrupted or failed; resume from the existing session and worktree state.",
    "Inspect the current GitHub Issue, this Repository's agent/project instructions, and any partial work already present.",
    "Finish the implementation in this worktree and run appropriate verification.",
    "Do not merely propose a plan; complete the implementation work for that exact issue.",
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
    const githubIssueNumber = yield* resolveIssueNumber(context)

    const existingSessionId = priorSessionId(context)
    const prompt =
      existingSessionId === null
        ? buildImplementPrompt(
            repository.githubOwner,
            repository.githubRepo,
            githubIssueNumber,
          )
        : buildContinueImplementPrompt(
            repository.githubOwner,
            repository.githubRepo,
            githubIssueNumber,
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
            message: "OpenCode failed to implement the Work Item issue",
            worktreePath,
            cause,
          }),
      ),
    )

    if (result.sessionId.trim() === "") {
      return yield* new ImplementOpenCodeError({
        message: "OpenCode completed without returning a Session ID",
        worktreePath,
      })
    }

    return result.sessionId
  })
