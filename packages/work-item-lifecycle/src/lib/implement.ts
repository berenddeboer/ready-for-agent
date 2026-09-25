import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { DbService } from "@ready-for-agent/db-service"
import { resolveForgeIssuePresentation } from "@ready-for-agent/forge-contract"
import {
  type IssueSource,
  behaviourNotImplemented,
  describeIssueTracker,
  formatIssueDisplayId,
} from "@ready-for-agent/lifecycle-model"
import {
  type AgentTurnForgeAuth,
  AgentTurnForgeCredentialMissingError,
  type AgentTurnForgeRepository,
  InvalidCapturedAgentBackendError,
  agentTurnForgeCredentialGuidance,
  forgeDisplayName,
  resolveAgentTurnForgeAuth,
} from "./agent-turn-forge-auth.js"
import {
  ImplementForgeCredentialError,
  ImplementInvalidWorktreeContextError,
  ImplementIssueContextMissingError,
  ImplementOpenCodeError,
  ImplementRepositoryNotFoundError,
  ImplementWorktreeContextMissingError,
} from "./implement-errors.js"
import {
  findStoredIssueForSource,
  issueOperationsForge,
} from "./issue-source-execution.js"
import { notifyWorkStarted } from "./issue-tracker-execution.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { promptUserContentSection } from "./sanitize-prompt-user-content.js"
import { loadScopeHandoff } from "./scope-handoff.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"
import { workItemAttachmentDirectory } from "./work-item-attachment-directory.js"

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
      Effect.logWarning("Failed to persist Agent session id mid-implement", {
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
  if (!Number.isInteger(context.issueNumber) || context.issueNumber <= 0) {
    return Effect.fail(
      new ImplementIssueContextMissingError({
        workItemId: context.workItemId,
        message: "Implement requires a positive issue number on the Work Item",
      }),
    )
  }
  return Effect.succeed(context.issueNumber)
}

const implementTheIssuePromptLine =
  "Do not merely propose a plan; implement the requested changes in this worktree for that exact issue."

const visualEvidencePromptLines = (workItemId: string): readonly string[] => {
  const attachmentDirectory = workItemAttachmentDirectory({ workItemId })
  return [
    `Work Item attachment directory: ${attachmentDirectory}`,
    "If the Issue asks for visual PR evidence, capture a genuine before-shot before any repository change, then after/production into that directory. Do not open or edit a pull request to attach images.",
  ]
}

/**
 * How Implement presents the Issue to the agent. `tracker_issue` names the
 * tracker and carries the Issue text, since the agent has no Forge Issue to
 * open.
 */
type IssuePresentation =
  | { readonly kind: "forge_issue" }
  | {
      readonly kind: "tracker_issue"
      readonly source: IssueSource
      readonly trackerName: string
    }

/**
 * Presentation of the Original Issue Source, as its Issue Tracker
 * description decides. A context without a source is a Forge Issue.
 */
const implementPresentation = (
  source: IssueSource | undefined,
): IssuePresentation => {
  if (source === undefined) {
    return { kind: "forge_issue" }
  }
  const description = describeIssueTracker(source.tracker)
  const presentation = description.presentation
  switch (presentation.kind) {
    case "forge_issue":
      return { kind: "forge_issue" }
    case "tracker_issue":
      return {
        kind: "tracker_issue",
        source,
        trackerName: description.displayName,
      }
    case "not_implemented":
      return behaviourNotImplemented(source.tracker, "Implement presentation")
    default: {
      const _exhaustive: never = presentation
      return _exhaustive
    }
  }
}

/**
 * Issue identity and source-credential guidance in the prompt follow the
 * Original Issue Source. Git/PR credentials follow the Repository hosting
 * Forge. GitHub stays ambient; GitLab and Azure DevOps name the host.
 */
const buildImplementPrompt = (
  gitRepository: AgentTurnForgeRepository,
  issueNumber: number,
  workItemId: string,
  forgeAuth: AgentTurnForgeAuth,
  mode: "start" | "continue",
  issueUrl: string | undefined,
  issuePresentation: IssuePresentation,
  liveIssue: { readonly title: string; readonly body: string } | null,
) => {
  if (issuePresentation.kind === "tracker_issue") {
    const { source: issueSource, trackerName } = issuePresentation
    const display = formatIssueDisplayId(issueSource.displayId)
    const identityLine =
      mode === "start"
        ? `Implement ${trackerName} issue ${display}.`
        : `Continue implementing ${trackerName} issue ${display}.`
    const inspectLine =
      mode === "start"
        ? `Inspect the current ${trackerName} Issue and this Repository's agent/project instructions.`
        : `Inspect the current ${trackerName} Issue, this Repository's agent/project instructions, and any partial work already present.`
    const contentLines =
      liveIssue === null
        ? []
        : [
            promptUserContentSection("issue_title", liveIssue.title),
            promptUserContentSection("issue_body", liveIssue.body),
          ]
    return [
      identityLine,
      issueSource.url,
      ...(mode === "continue"
        ? [
            "A previous Implement attempt was interrupted or failed; resume from the existing session and worktree state.",
          ]
        : []),
      inspectLine,
      ...contentLines,
      `Leave the tracker Issue open. Do not close, complete, or change its ${trackerName} workflow state.`,
      `Implement in this GitHub Repository. Do not fabricate a GitHub numeric closing reference for this ${trackerName} Issue.`,
      mode === "start"
        ? "Make the implementation in this worktree and run appropriate verification."
        : "Finish the implementation in this worktree and run appropriate verification.",
      implementTheIssuePromptLine,
      ...visualEvidencePromptLines(workItemId),
    ].join("\n")
  }

  const presentation = resolveForgeIssuePresentation({
    forge: gitRepository.forge,
    forgeHost: gitRepository.forgeHost,
    projectPath: gitRepository.projectPath,
    issueNumber,
  })
  const identityLine =
    mode === "start"
      ? `Implement ${presentation.identityText}.`
      : `Continue implementing ${presentation.identityText}.`
  const inspectLine =
    mode === "start"
      ? `Inspect the current ${presentation.issueNoun} and this Repository's agent/project instructions.`
      : `Inspect the current ${presentation.issueNoun}, this Repository's agent/project instructions, and any partial work already present.`
  const credentialLine = presentation.includeCredentialGuidance
    ? [
        agentTurnForgeCredentialGuidance(
          gitRepository,
          forgeAuth,
          presentation.implementAccessScope,
        ),
      ]
    : []
  const urlLine =
    issueUrl !== undefined && issueUrl.trim() !== "" ? [issueUrl] : []
  return [
    identityLine,
    ...urlLine,
    ...(mode === "continue"
      ? [
          "A previous Implement attempt was interrupted or failed; resume from the existing session and worktree state.",
        ]
      : []),
    inspectLine,
    ...credentialLine,
    presentation.stayOpenGuidance,
    mode === "start"
      ? "Make the implementation in this worktree and run appropriate verification."
      : "Finish the implementation in this worktree and run appropriate verification.",
    implementTheIssuePromptLine,
    "Deliver the smallest change satisfying the agreed scope. Existing upstream limitations and speculative hardening are follow-up observations, not new requirements. If a requirement genuinely needs broader work, request a scope decision before expanding it.",
    "Run appropriate verification; the harness owns the full review cycle. Do not launch your own full-worktree reviews.",
    ...visualEvidencePromptLines(workItemId),
  ].join("\n")
}

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
    const issueNumber = yield* resolveIssueNumber(context)
    const issueForge = issueOperationsForge(
      context.issueSource,
      repository.forge,
    )
    const issuePresentation = implementPresentation(context.issueSource)
    const gitForge =
      issuePresentation.kind === "tracker_issue" ? repository.forge : issueForge
    if (gitForge === null) {
      return yield* new ImplementIssueContextMissingError({
        workItemId: context.workItemId,
        message:
          "Implement requires a Forge-hosted Repository for git and pull requests",
      })
    }
    const gitRepository = {
      forge: gitForge,
      forgeHost: repository.forgeHost,
      projectPath: repository.projectPath,
    }
    const forgeAuth = yield* resolveAgentTurnForgeAuth(gitRepository).pipe(
      Effect.mapError((cause) => {
        if (
          cause instanceof AgentTurnForgeCredentialMissingError ||
          cause instanceof InvalidCapturedAgentBackendError
        ) {
          return new ImplementForgeCredentialError({
            repositoryId: context.repositoryId,
            message: cause.message,
          })
        }
        return new ImplementForgeCredentialError({
          repositoryId: context.repositoryId,
          message: `Failed to resolve the ${forgeDisplayName(gitForge)} credential`,
          cause,
        })
      }),
    )

    yield* notifyWorkStarted({
      repository,
      issueSource: context.issueSource,
      workItemId: context.workItemId,
    })

    const db = yield* DbService
    const storedIssue = findStoredIssueForSource(
      yield* db.listIssues(context.repositoryId),
      context.issueSource,
      issueNumber,
    )
    const liveIssue =
      storedIssue === undefined
        ? context.issueTitle === null
          ? null
          : { title: context.issueTitle, body: "" }
        : { title: storedIssue.title, body: storedIssue.body }

    const existingSessionId = priorSessionId(context)
    const implementationPrompt = buildImplementPrompt(
      gitRepository,
      issueNumber,
      context.workItemId,
      forgeAuth,
      existingSessionId === null ? "start" : "continue",
      context.issueSource?.url,
      issuePresentation,
      issuePresentation.kind === "tracker_issue" ? liveIssue : null,
    )
    const scopeHandoff = yield* loadScopeHandoff(context, worktreePath)
    const prompt = `${implementationPrompt}\n\n${scopeHandoff}`

    const agentBackend = yield* AgentBackend
    const sql = yield* SqlClient.SqlClient
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
            message: `${agentBackendLabel(context.agentBackend)} failed to implement the Work Item issue`,
            worktreePath,
            cause,
          }),
      ),
    )

    if (result.sessionId.trim() === "") {
      return yield* new ImplementOpenCodeError({
        message: `${agentBackendLabel(context.agentBackend)} completed without returning a Session ID`,
        worktreePath,
      })
    }

    return result.sessionId
  })
