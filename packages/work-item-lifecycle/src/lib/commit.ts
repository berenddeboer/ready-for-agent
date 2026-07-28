import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import {
  CommitInvalidWorktreeContextError,
  CommitOpenCodeError,
  CommitPostconditionError,
  CommitSessionContextMissingError,
  CommitStartingCommitMissingError,
  CommitWorktreeContextMissingError,
} from "./commit-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleStepCompletion,
} from "./types.js"

const DIAGNOSTIC_CHAR_LIMIT = 4_000
const HARNESS_ARTIFACT_PATHSPEC = ":(exclude).ready-for-agent"

export type CommitResult = {
  readonly completion: LifecycleStepCompletion
}

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

const resolveStartingCommitOid = (context: LifecycleStepContext) => {
  const startingCommitOid = context.startingCommitOid
  if (startingCommitOid === null || startingCommitOid.trim() === "") {
    return Effect.fail(
      new CommitStartingCommitMissingError({
        workItemId: context.workItemId,
        message:
          "Commit requires a starting commit OID persisted by Create Worktree",
      }),
    )
  }
  return Effect.succeed(startingCommitOid)
}

const resolveSessionId = (context: LifecycleStepContext) => {
  const sessionId = context.sessionId
  if (sessionId === null || sessionId.trim() === "") {
    return Effect.fail(
      new CommitSessionContextMissingError({
        workItemId: context.workItemId,
        message:
          "Commit agent fallback requires a Session ID persisted by a successful Implement Step Run",
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
        return {
          exitCode: Number(exitCode),
          stdout,
          stderr,
          output: [stdout, stderr]
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .join("\n"),
        }
      }),
    )
  })

const boundDiagnostics = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length <= DIAGNOSTIC_CHAR_LIMIT) {
    return trimmed === "" ? "(no output)" : trimmed
  }
  return `${trimmed.slice(0, DIAGNOSTIC_CHAR_LIMIT)}\n…(truncated)`
}

/**
 * Deterministic commit message from Issue identity and title with GitHub
 * closing semantics. Repository hooks may still reject the wording; the agent
 * fallback repairs policy-specific failures.
 */
export const buildDeterministicCommitMessage = (input: {
  readonly githubIssueNumber: number
  readonly issueTitle: string | null
}): string => {
  const title =
    input.issueTitle === null || input.issueTitle.trim() === ""
      ? `Implement issue #${input.githubIssueNumber}`
      : input.issueTitle.trim()
  return [
    `${title} (#${input.githubIssueNumber})`,
    "",
    `Closes #${input.githubIssueNumber}`,
  ].join("\n")
}

const buildCommitFallbackPrompt = (
  githubIssueNumber: number,
  diagnostics: string,
) =>
  [
    "The harness attempted to create a git commit for the implementation changes in this worktree and failed.",
    "Repair the underlying problem and create the commit yourself.",
    "Follow this repository's commit message conventions (for example conventional commits if the repo uses them).",
    `The commit message must mention that it closes GitHub issue #${githubIssueNumber}.`,
    "Stage only the relevant implementation changes, then commit.",
    "Exclude harness-owned diagnostic artifacts such as `.ready-for-agent/`.",
    "If there is nothing left to commit because a valid commit already exists for this work, succeed without creating an empty commit.",
    "Do not open a pull request.",
    "",
    "Bounded native failure diagnostics:",
    diagnostics,
  ].join("\n")

const hasCommitsAfterStartingOid = (
  worktreePath: string,
  startingCommitOid: string,
) =>
  runGitInWorktree(worktreePath, [
    "rev-list",
    "--count",
    `${startingCommitOid}..HEAD`,
  ]).pipe(
    Effect.map((result) => {
      if (result.exitCode !== 0) {
        return false
      }
      const count = Number.parseInt(result.stdout.trim(), 10)
      return Number.isFinite(count) && count > 0
    }),
  )

/**
 * Postcondition: at least one commit exists after the Work Item starting
 * commit and intended implementation changes (excluding harness artifacts)
 * are committed. Non-zero git status is treated as unmet (not "clean").
 */
const commitPostconditionMet = (
  worktreePath: string,
  startingCommitOid: string,
) =>
  Effect.gen(function* () {
    const hasCommits = yield* hasCommitsAfterStartingOid(
      worktreePath,
      startingCommitOid,
    )
    if (!hasCommits) {
      return false
    }
    const status = yield* runGitInWorktree(worktreePath, [
      "status",
      "--porcelain",
      "--",
      ".",
      HARNESS_ARTIFACT_PATHSPEC,
    ])
    if (status.exitCode !== 0) {
      return false
    }
    return status.stdout.trim().length === 0
  })

const collectGitStateDiagnostics = (worktreePath: string) =>
  Effect.gen(function* () {
    const status = yield* runGitInWorktree(worktreePath, [
      "status",
      "--porcelain",
    ])
    const log = yield* runGitInWorktree(worktreePath, [
      "log",
      "--oneline",
      "-5",
    ])
    return boundDiagnostics(
      [
        "git status --porcelain:",
        status.output || "(clean)",
        "",
        "git log --oneline -5:",
        log.output || "(no commits)",
      ].join("\n"),
    )
  })

const attemptNativeCommit = (worktreePath: string, message: string) =>
  Effect.gen(function* () {
    // Stage implementation changes only; never include harness diagnostics.
    const stage = yield* runGitInWorktree(worktreePath, [
      "add",
      "-A",
      "--",
      ".",
      HARNESS_ARTIFACT_PATHSPEC,
    ])
    if (stage.exitCode !== 0) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `git add failed (exit ${stage.exitCode})\n${stage.output}`,
        ),
      }
    }

    // Pre-Commit stages the whole worktree (`git add -A`). Selective add above
    // does not unstage paths already in the index — drop harness artifacts when
    // present. Unconditional `git reset -- .ready-for-agent` fails with a
    // pathspec error when the path is absent from the index (the common case
    // at Commit, before PR status diagnostics exist).
    const cachedHarness = yield* runGitInWorktree(worktreePath, [
      "ls-files",
      "--cached",
      "--",
      ".ready-for-agent",
    ])
    if (cachedHarness.exitCode !== 0) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `Failed to inspect staged harness artifacts (exit ${cachedHarness.exitCode})\n${cachedHarness.output}`,
        ),
      }
    }
    if (cachedHarness.stdout.trim().length > 0) {
      const unstageHarness = yield* runGitInWorktree(worktreePath, [
        "reset",
        "-q",
        "HEAD",
        "--",
        ".ready-for-agent",
      ])
      if (unstageHarness.exitCode !== 0) {
        return {
          ok: false as const,
          diagnostics: boundDiagnostics(
            `Failed to unstage harness artifacts before commit (exit ${unstageHarness.exitCode})\n${unstageHarness.output}`,
          ),
        }
      }
    }

    const staged = yield* runGitInWorktree(worktreePath, [
      "diff",
      "--cached",
      "--quiet",
    ])
    // Exit 0 = no staged changes; 1 = staged changes present.
    if (staged.exitCode === 0) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          "Native commit found nothing staged after excluding harness artifacts",
        ),
      }
    }
    if (staged.exitCode !== 1) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `git diff --cached --quiet failed (exit ${staged.exitCode})\n${staged.output}`,
        ),
      }
    }

    // Respect repository hooks and commit-message validation; do not bypass.
    const commit = yield* runGitInWorktree(worktreePath, [
      "commit",
      "-m",
      message,
    ])
    if (commit.exitCode !== 0) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `git commit failed (exit ${commit.exitCode})\n${commit.output}`,
        ),
      }
    }
    return { ok: true as const }
  })

const askAgentToRepairCommit = (
  context: LifecycleStepContext,
  worktreePath: string,
  sessionId: string,
  diagnostics: string,
) =>
  Effect.gen(function* () {
    const agentBackend = yield* AgentBackend
    yield* agentBackend
      .continueTurn({
        sessionId,
        prompt: buildCommitFallbackPrompt(
          context.githubIssueNumber,
          diagnostics,
        ),
        cwd: worktreePath,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        timeout: context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.commit,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CommitOpenCodeError({
              message: `${agentBackendLabel(context.agentBackend)} failed to commit the Work Item changes`,
              worktreePath,
              sessionId,
              cause,
            }),
        ),
      )
  })

/**
 * Production Commit Lifecycle Step.
 * Attempts a harness-owned deterministic git commit first. Continues the
 * Implement Session only when the native attempt does not establish the
 * postcondition (repair fallback). Success requires a commit after the Work
 * Item starting OID with implementation changes committed.
 */
export const commit = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const startingCommitOid = yield* resolveStartingCommitOid(context)

    // Operator Retry / indeterminate prior attempt: re-check before mutating.
    if (yield* commitPostconditionMet(worktreePath, startingCommitOid)) {
      return { completion: "native" } satisfies CommitResult
    }

    const message = buildDeterministicCommitMessage({
      githubIssueNumber: context.githubIssueNumber,
      issueTitle: context.issueTitle,
    })
    const native = yield* attemptNativeCommit(worktreePath, message)

    // Always re-check after the native attempt: a successful commit with a lost
    // process response must not fall through to a duplicate agent commit.
    if (yield* commitPostconditionMet(worktreePath, startingCommitOid)) {
      return { completion: "native" } satisfies CommitResult
    }

    const gitState = yield* collectGitStateDiagnostics(worktreePath)
    const diagnostics = native.ok
      ? boundDiagnostics(
          `Native commit command reported success but postcondition is absent.\n${gitState}`,
        )
      : boundDiagnostics(`${native.diagnostics}\n\n${gitState}`)

    const sessionId = yield* resolveSessionId(context)
    yield* askAgentToRepairCommit(context, worktreePath, sessionId, diagnostics)

    if (yield* commitPostconditionMet(worktreePath, startingCommitOid)) {
      return { completion: "agent_fallback" } satisfies CommitResult
    }

    const afterFallback = yield* collectGitStateDiagnostics(worktreePath)
    return yield* new CommitPostconditionError({
      message:
        "Commit postcondition is still absent after native attempt and agent fallback",
      worktreePath,
      diagnostics: afterFallback,
    })
  })
