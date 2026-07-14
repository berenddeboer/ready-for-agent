import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  CommitFailedError,
  CommitInvalidWorktreeContextError,
  CommitStageError,
  CommitWorktreeContextMissingError,
} from "./commit-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new CommitWorktreeContextMissingError({
        workItemId: context.workItemId,
        message: "Commit requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new CommitInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new CommitInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path is not a directory: ${worktreePath}`,
      })
    }

    return worktreePath
  })

const runGitInWorktree = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make("git", args, {
      cwd,
      stdin: "ignore",
    })

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          ],
          { concurrency: 3 },
        )
        const output = [stdout, stderr]
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .join("\n")
        return {
          exitCode: Number(exitCode),
          output,
        }
      }),
    )
  })

const commitMessage = (context: LifecycleStepContext): string =>
  `Implement #${context.githubIssueNumber}`

/**
 * Production Commit Lifecycle Step.
 * Stages all worktree changes and creates a local git commit when the index is
 * non-empty. A clean index after staging succeeds without creating a commit so
 * re-runs and already-committed worktrees remain re-entrant.
 */
export const commit = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)

    const stage = yield* runGitInWorktree(worktreePath, ["add", "-A"])
    if (stage.exitCode !== 0) {
      return yield* new CommitStageError({
        message: `Failed to stage worktree changes before commit (exit ${stage.exitCode})`,
        worktreePath,
        exitCode: stage.exitCode,
        output: stage.output || "(no output)",
      })
    }

    const staged = yield* runGitInWorktree(worktreePath, [
      "diff",
      "--cached",
      "--quiet",
    ])
    // git diff --quiet: 0 = no diff, 1 = has diff, other = error
    if (staged.exitCode === 0) {
      return
    }
    if (staged.exitCode !== 1) {
      return yield* new CommitFailedError({
        message: `Failed to inspect staged changes before commit (exit ${staged.exitCode})`,
        worktreePath,
        exitCode: staged.exitCode,
        output: staged.output || "(no output)",
      })
    }

    const result = yield* runGitInWorktree(worktreePath, [
      "commit",
      "-m",
      commitMessage(context),
    ])
    if (result.exitCode !== 0) {
      return yield* new CommitFailedError({
        message: `git commit failed (exit ${result.exitCode})`,
        worktreePath,
        exitCode: result.exitCode,
        output: result.output || "(no output)",
      })
    }
  })
