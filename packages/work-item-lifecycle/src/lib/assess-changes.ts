import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  AssessChangesInvalidWorktreeContextError,
  AssessChangesNoObservableChangeError,
  AssessChangesStartingCommitMissingError,
  AssessChangesWorktreeContextMissingError,
} from "./assess-changes-errors.js"
import { GitCommandError } from "./create-worktree-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new AssessChangesWorktreeContextMissingError({
        workItemId: context.workItemId,
        message:
          "Assess Changes requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new AssessChangesInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new AssessChangesInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path is not a directory: ${worktreePath}`,
      })
    }

    return worktreePath
  })

const resolveStartingCommitOid = (context: LifecycleStepContext) => {
  const startingCommitOid = context.startingCommitOid
  if (startingCommitOid === null || startingCommitOid.trim() === "") {
    return Effect.fail(
      new AssessChangesStartingCommitMissingError({
        workItemId: context.workItemId,
        message:
          "Assess Changes requires a starting commit OID persisted by Create Worktree",
      }),
    )
  }
  return Effect.succeed(startingCommitOid)
}

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
        if (Number(exitCode) !== 0) {
          return yield* new GitCommandError({
            message: `git ${args.join(" ")} failed with exit ${exitCode}`,
            command: "git",
            args: [...args],
            cwd,
            exitCode: Number(exitCode),
            stderr: stderr.trim(),
          })
        }
        return stdout
      }),
    )
  })

const hasWorkingTreeChanges = (worktreePath: string) =>
  runGitInWorktree(worktreePath, ["status", "--porcelain"]).pipe(
    Effect.map((stdout) => stdout.trim().length > 0),
  )

const hasCommitsAfterStartingOid = (
  worktreePath: string,
  startingCommitOid: string,
) =>
  runGitInWorktree(worktreePath, [
    "rev-list",
    "--count",
    `${startingCommitOid}..HEAD`,
  ]).pipe(
    Effect.map((stdout) => {
      const count = Number.parseInt(stdout.trim(), 10)
      return Number.isFinite(count) && count > 0
    }),
  )

/**
 * Production Assess Changes Lifecycle Step.
 *
 * Compares the worktree and branch against the Create Worktree starting commit
 * OID. Observable repository changes (staged, unstaged, untracked, or commits
 * after the starting OID) succeed and advance to Pre-Commit without continuing
 * the OpenCode Session. Git inspection failures leave the step retryable.
 */
export const assessChanges = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const startingCommitOid = yield* resolveStartingCommitOid(context)

    const dirty = yield* hasWorkingTreeChanges(worktreePath)
    if (dirty) {
      return
    }

    const commitsAfter = yield* hasCommitsAfterStartingOid(
      worktreePath,
      startingCommitOid,
    )
    if (commitsAfter) {
      return
    }

    return yield* new AssessChangesNoObservableChangeError({
      workItemId: context.workItemId,
      startingCommitOid,
      message:
        "No observable repository changes since the starting commit; Assess Changes is not complete",
    })
  })
