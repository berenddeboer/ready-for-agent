import { dirname } from "node:path"
import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  PreCommitInvalidWorktreeContextError,
  PreCommitOpenCodeError,
  PreCommitSessionContextMissingError,
  PreCommitStageError,
  PreCommitWorktreeContextMissingError,
} from "./pre-commit-errors.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

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

const resolveSessionId = (context: LifecycleStepContext) => {
  const sessionId = context.sessionId
  if (sessionId === null || sessionId.trim() === "") {
    return Effect.fail(
      new PreCommitSessionContextMissingError({
        workItemId: context.workItemId,
        message:
          "Pre-Commit requires a Session ID persisted by a successful Implement Step Run",
      }),
    )
  }
  return Effect.succeed(sessionId)
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

const writeHookOutputLog = (workItemId: string, output: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const logPath = yield* Effect.acquireRelease(
      fs.makeTempFile({
        prefix: `ready-for-agent-pre-commit-${workItemId}-`,
        suffix: ".log",
      }),
      (path) =>
        fs
          .remove(dirname(path), { recursive: true, force: true })
          .pipe(Effect.orDie),
    )
    yield* fs.writeFileString(logPath, output)
    yield* fs.chmod(logPath, 0o600)
    return logPath
  })

const buildFixPrompt = (exitCode: number, logPath: string) =>
  [
    "The repository pre-commit hook failed after staging the worktree changes.",
    `Exit code: ${exitCode}`,
    `Full hook output is at: ${logPath}`,
    "Do not read that log or re-run the pre-commit hook in this main session — hook output is noisy and must stay out of the main context.",
    "Delegate to a sub-agent that:",
    "1. Reads the log and/or runs `git hook run --ignore-missing pre-commit` in this worktree",
    "2. Returns only a concise summary of what failed and what to fix (no raw hook logs)",
    "Use that summary to diagnose and fix the failures in this worktree so pre-commit can pass.",
    "When re-checking, use a sub-agent again for the same reason; only bring back pass/fail plus a short failure summary.",
    "Do not create a git commit or open a pull request.",
  ].join("\n")

const askOpencodeToFix = (
  context: LifecycleStepContext,
  worktreePath: string,
  sessionId: string,
  exitCode: number,
  output: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const logPath = yield* writeHookOutputLog(context.workItemId, output)
      const opencode = yield* Opencode
      yield* opencode
        .continue({
          sessionId,
          prompt: buildFixPrompt(exitCode, logPath),
          cwd: worktreePath,
          model: context.model,
          variant: context.variant,
          timeout:
            context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.pre_commit,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PreCommitOpenCodeError({
                message:
                  "OpenCode failed to fix pre-commit validation failures",
                worktreePath,
                sessionId,
                cause,
              }),
          ),
        )
    }),
  )

/**
 * Production Pre-Commit Lifecycle Step.
 * Stages all worktree changes then runs the repository pre-commit hook via
 * `git hook run --ignore-missing pre-commit`. Missing hooks succeed. A failing
 * hook writes full output to a temp log, continues the Implement OpenCode
 * Session with instructions to diagnose via a sub-agent (keeping raw hook
 * logs out of the main context), then re-stages and re-runs until the hook
 * passes (bounded by the step max duration). OpenCode or stage failures fail
 * the Step Run.
 */
export const preCommit = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const sessionId = yield* resolveSessionId(context)

    for (;;) {
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
      if (hook.exitCode === 0) {
        return
      }

      yield* askOpencodeToFix(
        context,
        worktreePath,
        sessionId,
        hook.exitCode,
        hook.output || "(no output)",
      )
    }
  })
