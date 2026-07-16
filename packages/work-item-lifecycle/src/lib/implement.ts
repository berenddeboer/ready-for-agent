import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DbService } from "@ready-for-agent/db-service"
import { Opencode } from "@ready-for-agent/opencode"
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
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = Date.now()
    yield* sql.unsafe(
      `UPDATE work_item
       SET session_id = ?, updated_at = ?
       WHERE id = ?
         AND (session_id IS NULL OR session_id = '' OR session_id = ?)`,
      [sessionId, now, workItemId, sessionId],
    )
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

/**
 * Production Implement Lifecycle Step.
 * Starts a fresh OpenCode Session in the Work Item worktree and asks it to
 * implement the referenced GitHub Issue. Always uses start — never continue.
 */
export const implement = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const repository = yield* resolveRepository(context)
    const githubIssueNumber = yield* resolveIssueNumber(context)

    const prompt = buildImplementPrompt(
      repository.githubOwner,
      repository.githubRepo,
      githubIssueNumber,
    )

    const opencode = yield* Opencode
    const sql = yield* SqlClient.SqlClient
    // Always start a fresh Session. Ignore any prior context.sessionId from
    // setup, dependency installation, or a previous failed Step Run.
    const result = yield* opencode
      .start({
        prompt,
        cwd: worktreePath,
        model: context.model,
        variant: context.variant,
        timeout:
          context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.implement,
        onSessionId: (sessionId) =>
          persistSessionIdMidRun(context.workItemId, sessionId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
      })
      .pipe(
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
