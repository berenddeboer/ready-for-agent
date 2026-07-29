import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { DbService } from "@ready-for-agent/db-service"
import { CurrentStepRun } from "./agent-turn-limiter.js"
import {
  CommitInvalidWorktreeContextError,
  CommitOpenCodeError,
  CommitPostconditionError,
  CommitPublicationCopyError,
  CommitSessionContextMissingError,
  CommitStartingCommitMissingError,
  CommitWorktreeContextMissingError,
} from "./commit-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  type PublicationCopy,
  buildCommitFallbackPromptWithCopy,
  buildPublicationCopyFormatCorrectionPrompt,
  buildPublicationCopyPrompt,
  formatPublicationCommitMessage,
  normalizePublicationCopy,
  parsePublicationCopyResult,
  publicationCopyFromCommitMessage,
} from "./publication-copy.js"
import {
  COMMIT_COPY_GENERATION_MESSAGE,
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleStepCompletion,
  STEP_RUN_REASON,
} from "./types.js"

const DIAGNOSTIC_CHAR_LIMIT = 4_000
const HARNESS_ARTIFACT_PATHSPEC = ":(exclude).ready-for-agent"

export type CommitResult = {
  readonly completion: LifecycleStepCompletion
  readonly publicationTitle: string
  readonly publicationBody: string
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
          "Commit requires a Session ID persisted by a successful Implement Step Run for publication copy and agent repair",
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

const readHeadCommitMessage = (worktreePath: string) =>
  runGitInWorktree(worktreePath, ["log", "-1", "--pretty=%B"]).pipe(
    Effect.map((result) =>
      result.exitCode === 0 ? result.stdout.replace(/\r\n/g, "\n") : "",
    ),
  )

const markCopyGenerationPhase = Effect.gen(function* () {
  const current = yield* CurrentStepRun
  if (current === null) {
    return
  }
  const sql = yield* SqlClient.SqlClient
  const db = yield* DbService
  const now = Date.now()
  yield* sql.unsafe(
    `UPDATE step_run
     SET reason_code = ?,
         reason_message = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'running'`,
    [
      STEP_RUN_REASON.copyGeneration,
      COMMIT_COPY_GENERATION_MESSAGE,
      now,
      current.stepRunId,
    ],
  )
  yield* db.notifyWorkItemsChanged(current.repositoryId)
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning("Failed to mark Commit Step Run as copy_generation", {
      error,
    }),
  ),
  Effect.asVoid,
)

/**
 * Persist canonical publication copy before native git mutations so retries
 * and restarts reuse it. Soft-fails on SQL/update errors; unit tests either
 * provide SqlClient or skip the generation/seed path.
 */
const persistPublicationCopy = (
  workItemId: string,
  copy: PublicationCopy,
): Effect.Effect<void, never, SqlClient.SqlClient | DbService> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const db = yield* DbService
    const now = Date.now()
    yield* sql.unsafe(
      `UPDATE work_item
       SET publication_title = ?,
           publication_body = ?,
           updated_at = ?
       WHERE id = ?`,
      [copy.title, copy.body, now, workItemId],
    )
    const current = yield* CurrentStepRun
    if (current !== null) {
      yield* db.notifyWorkItemsChanged(current.repositoryId)
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Failed to persist publication copy mid-Commit", {
        error,
        workItemId,
      }),
    ),
    Effect.asVoid,
  )

const parseAndNormalize = (
  assistantText: string,
  issueNumber: number,
): PublicationCopy | null => {
  const parsed = parsePublicationCopyResult(assistantText)
  if (parsed === null) {
    return null
  }
  return normalizePublicationCopy(parsed, issueNumber)
}

const generatePublicationCopy = (
  context: LifecycleStepContext,
  worktreePath: string,
  sessionId: string,
) =>
  Effect.gen(function* () {
    yield* markCopyGenerationPhase
    const agentBackend = yield* AgentBackend
    const timeout =
      context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.commit

    const first = yield* agentBackend
      .continueTurn({
        sessionId,
        prompt: buildPublicationCopyPrompt(context.issueNumber),
        cwd: worktreePath,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        timeout,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CommitOpenCodeError({
              message: `${agentBackendLabel(context.agentBackend)} failed to generate publication copy`,
              worktreePath,
              sessionId,
              cause,
            }),
        ),
      )

    let copy = parseAndNormalize(first.assistantText, context.issueNumber)
    if (copy === null) {
      const correction = yield* agentBackend
        .continueTurn({
          sessionId,
          prompt: buildPublicationCopyFormatCorrectionPrompt(
            context.issueNumber,
          ),
          cwd: worktreePath,
          model: context.model,
          thinkingLevel: context.thinkingLevel,
          timeout,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CommitOpenCodeError({
                message: `${agentBackendLabel(context.agentBackend)} failed during publication copy format correction`,
                worktreePath,
                sessionId,
                cause,
              }),
          ),
        )
      copy = parseAndNormalize(correction.assistantText, context.issueNumber)
    }

    if (copy === null) {
      return yield* new CommitPublicationCopyError({
        workItemId: context.workItemId,
        message: `${agentBackendLabel(context.agentBackend)} did not report valid publication copy (unique final READY_FOR_AGENT_RESULT: PUBLICATION_COPY with nonblank title and substantive body). Did not fall back to Issue-title placeholder copy.`,
      })
    }

    return copy
  })

const resolvePublicationCopy = (
  context: LifecycleStepContext,
  worktreePath: string,
  options: {
    readonly postconditionAlreadyMet: boolean
  },
) =>
  Effect.gen(function* () {
    // When a commit already exists, HEAD is authoritative so Retry after agent
    // repair (or soft mid-persist failure) cannot publish stale copy.
    if (options.postconditionAlreadyMet) {
      const message = yield* readHeadCommitMessage(worktreePath)
      const seeded = publicationCopyFromCommitMessage(
        message,
        context.issueNumber,
      )
      if (seeded !== null) {
        const existingTitle = context.publicationTitle?.trim() ?? ""
        const existingBody = context.publicationBody?.trim() ?? ""
        if (existingTitle !== seeded.title || existingBody !== seeded.body) {
          yield* persistPublicationCopy(context.workItemId, seeded)
        }
        return seeded
      }
      // HEAD unreadable/empty: fall through to persisted fields if present.
    }

    const existingTitle = context.publicationTitle?.trim() ?? ""
    const existingBody = context.publicationBody?.trim() ?? ""
    if (existingTitle !== "" && existingBody !== "") {
      const normalized = normalizePublicationCopy(
        { title: existingTitle, body: existingBody },
        context.issueNumber,
      )
      // Already-persisted copy is trusted even if slightly over bounds after deploy;
      // re-normalize when possible, otherwise reuse as stored.
      if (normalized !== null) {
        return normalized
      }
      return { title: existingTitle, body: existingBody }
    }

    if (options.postconditionAlreadyMet) {
      return yield* new CommitPublicationCopyError({
        workItemId: context.workItemId,
        message:
          "Commit already exists but canonical publication copy is absent and the head commit message could not be seeded",
      })
    }

    const sessionId = yield* resolveSessionId(context)
    const generated = yield* generatePublicationCopy(
      context,
      worktreePath,
      sessionId,
    )
    yield* persistPublicationCopy(context.workItemId, generated)
    return generated
  })

/**
 * Align canonical copy with the actual HEAD commit message when hooks or
 * agent repair rewrote it. Persists only when the message differs.
 */
const alignCopyWithHeadCommit = (
  context: LifecycleStepContext,
  worktreePath: string,
  preferred: PublicationCopy,
) =>
  Effect.gen(function* () {
    const actualMessage = yield* readHeadCommitMessage(worktreePath)
    const fromCommit = publicationCopyFromCommitMessage(
      actualMessage,
      context.issueNumber,
    )
    if (fromCommit === null) {
      return preferred
    }
    if (
      fromCommit.title !== preferred.title ||
      fromCommit.body !== preferred.body
    ) {
      yield* persistPublicationCopy(context.workItemId, fromCommit)
    }
    return fromCommit
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
    const commitResult = yield* runGitInWorktree(worktreePath, [
      "commit",
      "-m",
      message,
    ])
    if (commitResult.exitCode !== 0) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `git commit failed (exit ${commitResult.exitCode})\n${commitResult.output}`,
        ),
      }
    }
    return { ok: true as const }
  })

const askAgentToRepairCommit = (
  context: LifecycleStepContext,
  worktreePath: string,
  sessionId: string,
  copy: PublicationCopy,
  diagnostics: string,
) =>
  Effect.gen(function* () {
    const agentBackend = yield* AgentBackend
    yield* agentBackend
      .continueTurn({
        sessionId,
        prompt: buildCommitFallbackPromptWithCopy({
          issueNumber: context.issueNumber,
          title: copy.title,
          body: copy.body,
          diagnostics,
        }),
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

const toResult = (
  completion: LifecycleStepCompletion,
  copy: PublicationCopy,
): CommitResult => ({
  completion,
  publicationTitle: copy.title,
  publicationBody: copy.body,
})

/**
 * Production Commit Lifecycle Step.
 *
 * Generates shared publication copy (or reuses/seeds persisted copy), then
 * attempts a harness-owned native git commit. Continues the Implement Session
 * only when the native attempt does not establish the postcondition (repair
 * fallback). Success requires a commit after the Work Item starting OID with
 * implementation changes committed.
 */
export const commit = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const startingCommitOid = yield* resolveStartingCommitOid(context)

    const alreadyCommitted = yield* commitPostconditionMet(
      worktreePath,
      startingCommitOid,
    )

    // Operator Retry / indeterminate prior attempt: re-check before mutating.
    // Still ensure canonical publication copy exists (seed from commit if needed).
    if (alreadyCommitted) {
      const copy = yield* resolvePublicationCopy(context, worktreePath, {
        postconditionAlreadyMet: true,
      })
      return toResult("native", copy)
    }

    const copy = yield* resolvePublicationCopy(context, worktreePath, {
      postconditionAlreadyMet: false,
    })
    const message = formatPublicationCommitMessage(copy)
    const native = yield* attemptNativeCommit(worktreePath, message)

    // Always re-check after the native attempt: a successful commit with a lost
    // process response must not fall through to a duplicate agent commit.
    if (yield* commitPostconditionMet(worktreePath, startingCommitOid)) {
      // prepare-commit-msg (or similar) may rewrite the message on success.
      const aligned = yield* alignCopyWithHeadCommit(
        context,
        worktreePath,
        copy,
      )
      return toResult("native", aligned)
    }

    const gitState = yield* collectGitStateDiagnostics(worktreePath)
    const diagnostics = native.ok
      ? boundDiagnostics(
          `Native commit command reported success but postcondition is absent.\n${gitState}`,
        )
      : boundDiagnostics(`${native.diagnostics}\n\n${gitState}`)

    const sessionId = yield* resolveSessionId(context)
    yield* askAgentToRepairCommit(
      context,
      worktreePath,
      sessionId,
      copy,
      diagnostics,
    )

    if (yield* commitPostconditionMet(worktreePath, startingCommitOid)) {
      // Agent may have rewritten the message for policy; re-seed so Create PR matches.
      const finalCopy = yield* alignCopyWithHeadCommit(
        context,
        worktreePath,
        copy,
      )
      return toResult("agent_fallback", finalCopy)
    }

    const afterFallback = yield* collectGitStateDiagnostics(worktreePath)
    return yield* new CommitPostconditionError({
      message:
        "Commit postcondition is still absent after native attempt and agent fallback",
      worktreePath,
      diagnostics: afterFallback,
    })
  })
