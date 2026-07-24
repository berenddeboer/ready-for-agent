import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import {
  type InstallCommand,
  type InstallPlan,
  detectInstallPlan,
} from "./detect-install-plan.js"
import {
  InstallCommandError,
  InstallDependenciesFallbackError,
  InvalidWorktreeContextError,
  WorktreeContextMissingError,
} from "./install-dependencies-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"

const STDERR_DIAGNOSTIC_LIMIT = 4_000

const appendDiagnosticTail = (tail: string, chunk: string): string => {
  const combined = `${tail}${chunk}`
  return combined.length <= STDERR_DIAGNOSTIC_LIMIT
    ? combined
    : `…${combined.slice(-(STDERR_DIAGNOSTIC_LIMIT - 1))}`
}

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new WorktreeContextMissingError({
        workItemId: context.workItemId,
        message:
          "Install Dependencies requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new InvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new InvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path is not a directory: ${worktreePath}`,
      })
    }

    return worktreePath
  })

const runInstallCommand = (cwd: string, install: InstallCommand) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make(install.command, install.args, {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
    })

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        const [exitCode, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.decodeText(handle.stderr).pipe(
              Stream.runFold(() => "", appendDiagnosticTail),
            ),
          ],
          { concurrency: 2 },
        )
        return {
          exitCode: Number(exitCode),
          stderr: stderr.trim(),
        }
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new InstallCommandError({
            message: `Unable to run ${install.command} ${install.args.join(" ")}`,
            command: install.command,
            args: install.args,
            cwd,
            exitCode: -1,
            stderr: String(cause),
          }),
      ),
    )

    if (result.exitCode !== 0) {
      return yield* new InstallCommandError({
        message: `${install.command} ${install.args.join(" ")} failed with exit ${result.exitCode}`,
        command: install.command,
        args: install.args,
        cwd,
        exitCode: result.exitCode,
        stderr: result.stderr,
      })
    }
  })

const ambiguousFallbackPrompt = (
  plan: Extract<InstallPlan, { _tag: "Fallback" }>,
) =>
  [
    "Install project dependencies in this worktree using the package manager appropriate for this repository.",
    "Do not start implementation work.",
    `Detection could not choose a direct install command: ${plan.reason}`,
  ].join("\n")

const failedDirectFallbackPrompt = (error: InstallCommandError) =>
  [
    "Complete dependency installation in this worktree.",
    "Do not start implementation work.",
    `A direct install command failed: ${error.command} ${error.args.join(" ")}`,
    `Exit code: ${error.exitCode}`,
    `stderr: ${error.stderr || "(empty)"}`,
  ].join("\n")

const runOpencodeFallback = (
  context: LifecycleStepContext,
  worktreePath: string,
  prompt: string,
) =>
  Effect.gen(function* () {
    const agentBackend = yield* AgentBackend
    // Session id is intentionally discarded: install never persists a Session.
    yield* agentBackend
      .startTurn({
        prompt,
        cwd: worktreePath,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new InstallDependenciesFallbackError({
              message: "OpenCode fallback failed to install dependencies",
              worktreePath,
              cause,
            }),
        ),
        Effect.as(undefined),
      )
  })

/**
 * Production Install Dependencies Lifecycle Step.
 * Directly runs an unambiguous package-manager install, or delegates to
 * OpenCode when detection is inconclusive or the direct command fails.
 */
export const installDependencies = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const plan = yield* detectInstallPlan(worktreePath)

    if (plan._tag === "Fallback") {
      yield* runOpencodeFallback(
        context,
        worktreePath,
        ambiguousFallbackPrompt(plan),
      )
      return
    }

    yield* runInstallCommand(worktreePath, plan.install).pipe(
      Effect.catchTag("InstallCommandError", (error) =>
        runOpencodeFallback(
          context,
          worktreePath,
          failedDirectFallbackPrompt(error),
        ),
      ),
    )
  })
