import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import {
  AssessChangesInvalidWorktreeContextError,
  AssessChangesOpenCodeError,
  AssessChangesResultError,
  AssessChangesSessionMissingError,
  AssessChangesStartingCommitMissingError,
  AssessChangesWorktreeContextMissingError,
} from "./assess-changes-errors.js"
import { GitCommandError } from "./create-worktree-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

export type AssessChangesResult =
  | { readonly _tag: "changes" }
  | { readonly _tag: "no_changes"; readonly completionSummary: string }

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

const resolveSessionId = (context: LifecycleStepContext) => {
  const sessionId = context.sessionId
  if (sessionId === null || sessionId.trim() === "") {
    return Effect.fail(
      new AssessChangesSessionMissingError({
        workItemId: context.workItemId,
        message:
          "Assess Changes requires the Implement OpenCode Session when the worktree appears unchanged",
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
 * Parse the unique final READY_FOR_AGENT_RESULT line from Assess Changes.
 * Returns null for missing, duplicate, non-final, or unrecognized markers.
 */
export const parseAssessChangesResult = (
  output: string,
): AssessChangesResult | null => {
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

  if (/^READY_FOR_AGENT_RESULT:\s*CHANGES$/i.test(finalLine)) {
    return { _tag: "changes" }
  }

  if (/^READY_FOR_AGENT_RESULT:\s*NO_CHANGES$/i.test(finalLine)) {
    const summaryLines = nonEmptyLines.slice(0, -1)
    const completionSummary = summaryLines.join("\n").trim()
    if (completionSummary === "") {
      return null
    }
    return { _tag: "no_changes", completionSummary }
  }

  return null
}

const confirmNoObservableChange = (
  context: LifecycleStepContext,
  worktreePath: string,
  sessionId: string,
) =>
  Effect.gen(function* () {
    const prompt = [
      "The worktree and branch appear unchanged since this Work Item started.",
      "Confirm whether that absence of repository changes is intentional.",
      "Do not edit files, commit, push, open pull requests, or perform other repository work during this classification.",
      "If repository changes are still required or you believe changes exist, end with READY_FOR_AGENT_RESULT: CHANGES.",
      "If the Issue objective is complete without repository changes, write a concise Markdown completion summary for the GitHub Issue (include links to any follow-up Issues you created), then end with READY_FOR_AGENT_RESULT: NO_CHANGES.",
      "End your final response with exactly one machine-readable result line:",
      "READY_FOR_AGENT_RESULT: CHANGES",
      "or",
      "READY_FOR_AGENT_RESULT: NO_CHANGES",
    ].join("\n")

    const agentBackend = yield* AgentBackend
    const result = yield* agentBackend
      .continueTurn({
        sessionId,
        prompt,
        cwd: worktreePath,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        timeout:
          context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.assess_changes,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AssessChangesOpenCodeError({
              workItemId: context.workItemId,
              message:
                cause instanceof Error && cause.message.trim() !== ""
                  ? `OpenCode failed while confirming Assess Changes: ${cause.message}`
                  : "OpenCode failed while confirming Assess Changes",
              cause,
            }),
        ),
      )

    const parsed = parseAssessChangesResult(result.assistantText)
    if (parsed === null) {
      return yield* new AssessChangesResultError({
        workItemId: context.workItemId,
        message:
          "OpenCode did not report a unique final READY_FOR_AGENT_RESULT: CHANGES or NO_CHANGES with a non-blank summary when required",
      })
    }
    return parsed
  })

/**
 * Production Assess Changes Lifecycle Step.
 *
 * Compares the worktree and branch against the Create Worktree starting commit
 * OID. Observable repository changes succeed as CHANGES without continuing the
 * OpenCode Session. An apparently clean worktree continues the Implement
 * Session (build model/variant) for intentional NO_CHANGES confirmation.
 */
export const assessChanges = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const startingCommitOid = yield* resolveStartingCommitOid(context)

    const dirty = yield* hasWorkingTreeChanges(worktreePath)
    if (dirty) {
      return { _tag: "changes" as const }
    }

    const commitsAfter = yield* hasCommitsAfterStartingOid(
      worktreePath,
      startingCommitOid,
    )
    if (commitsAfter) {
      return { _tag: "changes" as const }
    }

    const sessionId = yield* resolveSessionId(context)
    return yield* confirmNoObservableChange(context, worktreePath, sessionId)
  })
