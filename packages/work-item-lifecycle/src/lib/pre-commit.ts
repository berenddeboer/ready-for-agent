import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  PreCommitHookFailedError,
  PreCommitInvalidWorktreeContextError,
  PreCommitStageError,
  PreCommitWorktreeContextMissingError,
} from "./pre-commit-errors.js"

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new PreCommitWorktreeContextMissingError({
        workItemId: context.workItemId,
        message:
          "Pre-Commit requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new PreCommitInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new PreCommitInvalidWorktreeContextError({
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

/**
 * Production Pre-Commit Lifecycle Step.
 * Stages all worktree changes then runs the repository pre-commit hook via
 * `git hook run --ignore-missing pre-commit`. Missing hooks succeed; a
 * failing hook fails the Step Run with full hook output.
 */
export const preCommit = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)

    const stage = yield* runGitInWorktree(worktreePath, ["add", "-A"])
    if (stage.exitCode !== 0) {
      return yield* new PreCommitStageError({
        message: `Failed to stage worktree changes before pre-commit (exit ${stage.exitCode})`,
        worktreePath,
        exitCode: stage.exitCode,
        output: stage.output || "(no output)",
      })
    }

    const hook = yield* runGitInWorktree(worktreePath, [
      "hook",
      "run",
      "--ignore-missing",
      "pre-commit",
    ])
    if (hook.exitCode !== 0) {
      return yield* new PreCommitHookFailedError({
        message: `Pre-commit validation failed (exit ${hook.exitCode})`,
        worktreePath,
        exitCode: hook.exitCode,
        output: hook.output || "(no output)",
      })
    }
  })
