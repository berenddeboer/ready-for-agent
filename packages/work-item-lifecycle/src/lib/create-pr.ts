import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  type AgentTurnGitHubAuth,
  AgentTurnGitHubCredentialMissingError,
  InvalidCapturedAgentBackendError,
  agentTurnGitHubCredentialGuidance,
  resolveAgentTurnGitHubAuth,
} from "./agent-turn-github-auth.js"
import {
  CreatePrCredentialError,
  CreatePrInvalidWorktreeContextError,
  CreatePrLookupError,
  CreatePrOpenCodeError,
  CreatePrPostconditionError,
  CreatePrSessionContextMissingError,
  CreatePrWorktreeContextMissingError,
} from "./create-pr-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleStepCompletion,
} from "./types.js"
import { workItemBranchName } from "./worktree-names.js"

const DIAGNOSTIC_CHAR_LIMIT = 4_000
const NATIVE_PUSH_TIMEOUT_MS = 60_000

export type CreatePrResult = {
  readonly pullRequestNumber: number
  readonly completion: LifecycleStepCompletion
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new CreatePrWorktreeContextMissingError({
        workItemId: context.workItemId,
        message:
          "Create PR requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new CreatePrInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new CreatePrInvalidWorktreeContextError({
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
      new CreatePrSessionContextMissingError({
        workItemId: context.workItemId,
        message:
          "Create PR agent fallback requires a Session ID persisted by a successful Implement Step Run",
      }),
    )
  }
  return Effect.succeed(sessionId)
}

const boundDiagnostics = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length <= DIAGNOSTIC_CHAR_LIMIT) {
    return trimmed === "" ? "(no output)" : trimmed
  }
  return `${trimmed.slice(0, DIAGNOSTIC_CHAR_LIMIT)}\n…(truncated)`
}

const errorMessage = (cause: unknown): string =>
  cause &&
  typeof cause === "object" &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : String(cause)

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

export const buildDeterministicPullRequestTitle = (input: {
  readonly githubIssueNumber: number
  readonly issueTitle: string | null
}): string => {
  if (input.issueTitle === null || input.issueTitle.trim() === "") {
    return `Implement #${input.githubIssueNumber}`
  }
  return input.issueTitle.trim()
}

export const buildDeterministicPullRequestBody = (
  githubIssueNumber: number,
): string =>
  [
    `Automated draft pull request for GitHub issue #${githubIssueNumber}.`,
    "",
    `Closes #${githubIssueNumber}`,
  ].join("\n")

const buildCreatePrFallbackPrompt = (
  githubIssueNumber: number,
  branch: string,
  auth: AgentTurnGitHubAuth,
  diagnostics: string,
) =>
  [
    "The harness attempted to open a draft pull request for the committed work in this worktree and failed.",
    "Repair the underlying problem (authentication, push, repository PR templates, or content requirements) and create the draft PR.",
    `The current Work Item branch is ${branch}. Keep this branch checked out and use it as the pull request head.`,
    "Do not create or switch to another branch.",
    "Push this exact branch if needed, then open a PR against the repository default base branch.",
    "Create the pull request as a draft.",
    `The PR must reference GitHub issue #${githubIssueNumber} (for example Closes #${githubIssueNumber}).`,
    "Follow this repository's PR title and body conventions.",
    `If a suitable open PR whose head is exactly ${branch} already exists, succeed without creating a duplicate.`,
    "Do not merge the pull request.",
    agentTurnGitHubCredentialGuidance(auth, "GitHub CLI or API access"),
    "",
    "Bounded native failure diagnostics:",
    diagnostics,
  ].join("\n")

/**
 * Hard lookup of an open PR. Failures surface as CreatePrLookupError.
 */
const findExistingOpenPr = (
  context: LifecycleStepContext,
  githubOwner: string,
  githubRepo: string,
  branch: string,
) =>
  Effect.gen(function* () {
    const github = yield* GitHubService
    return yield* github
      .findOpenPullRequestNumber(
        { owner: githubOwner, name: githubRepo },
        branch,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new CreatePrLookupError({
              repositoryId: context.repositoryId,
              message: `Failed to look up an open pull request for ${githubOwner}/${githubRepo}:${branch}`,
              cause,
            }),
        ),
      )
  })

/**
 * Soft lookup: transport/API failures become null so callers can fall through
 * to create-number acceptance or agent repair without aborting the step.
 */
const softFindExistingOpenPr = (
  context: LifecycleStepContext,
  githubOwner: string,
  githubRepo: string,
  branch: string,
) =>
  findExistingOpenPr(context, githubOwner, githubRepo, branch).pipe(
    Effect.orElseSucceed(() => null),
  )

const resolveRequiredOpenPr = (
  context: LifecycleStepContext,
  githubOwner: string,
  githubRepo: string,
  branch: string,
) =>
  Effect.gen(function* () {
    const github = yield* GitHubService
    return yield* github
      .getOpenPullRequestNumber(
        { owner: githubOwner, name: githubRepo },
        branch,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new CreatePrLookupError({
              repositoryId: context.repositoryId,
              message: `Failed to resolve the open pull request for ${githubOwner}/${githubRepo}:${branch}`,
              cause,
            }),
        ),
      )
  })

/**
 * Vault secret name for native push when Keymaxxer is enabled; null for ambient
 * (Keymaxxer disabled) or when no repository secret is configured.
 */
const resolveNativePushTokenName = (
  repositoryId: string,
  githubOwner: string,
  githubRepo: string,
) =>
  Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    if (keymaxxer.enabled === false) {
      return null
    }
    return yield* keymaxxer
      .findSecret({
        provider: "github",
        account: `${githubOwner}/${githubRepo}`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CreatePrCredentialError({
              repositoryId,
              message:
                "Failed to resolve the repository GitHub credential for native push",
              cause,
            }),
        ),
      )
  })

/**
 * Push the Work Item branch via the harness credential path when a vault
 * secret is available (Keymaxxer runWithSecrets + HTTPS Authorization header).
 * Ambient mode (Keymaxxer disabled) uses plain git push.
 */
const attemptNativePush = (
  worktreePath: string,
  branch: string,
  tokenName: string | null,
) =>
  Effect.gen(function* () {
    if (tokenName === null) {
      const push = yield* runGitInWorktree(worktreePath, [
        "push",
        "-u",
        "origin",
        branch,
      ])
      if (push.exitCode !== 0) {
        return {
          ok: false as const,
          diagnostics: boundDiagnostics(
            `git push failed (exit ${push.exitCode})\n${push.output}`,
          ),
        }
      }
      return { ok: true as const }
    }

    const keymaxxer = yield* KeymaxxerService
    // Keymaxxer injects vault secrets into the child env by secret name.
    // Put the secret-name expansion in the Authorization header directly —
    // bash does not apply prefix assignments (`GH_TOKEN=… git … $GH_TOKEN`)
    // to parameter expansion of later words on the same simple command, so
    // `bearer $GH_TOKEN` would expand empty. Prefer $${tokenName} which
    // expands from the injected env (or Keymaxxer command substitution).
    // Also export GH_TOKEN/GITHUB_TOKEN for any helper that reads them.
    const command = [
      `GH_TOKEN="$${tokenName}"`,
      `GITHUB_TOKEN="$${tokenName}"`,
      "git",
      "-C",
      shellQuote(worktreePath),
      "-c",
      `"http.https://github.com/.extraheader=AUTHORIZATION: bearer $${tokenName}"`,
      "push",
      "-u",
      "origin",
      shellQuote(branch),
    ].join(" ")

    const result = yield* keymaxxer
      .runWithSecrets({
        command,
        cwd: worktreePath,
        secrets: [tokenName],
        timeoutMs: NATIVE_PUSH_TIMEOUT_MS,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: `Keymaxxer runWithSecrets failed: ${errorMessage(cause)}`,
          }),
        ),
      )

    if (result.exitCode !== 0) {
      const output = [result.stdout, result.stderr]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("\n")
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `credentialed git push failed (exit ${result.exitCode})\n${output}`,
        ),
      }
    }
    return { ok: true as const }
  })

const attemptNativeCreateDraft = (
  context: LifecycleStepContext,
  githubOwner: string,
  githubRepo: string,
  branch: string,
) =>
  Effect.gen(function* () {
    const github = yield* GitHubService
    const title = buildDeterministicPullRequestTitle({
      githubIssueNumber: context.githubIssueNumber,
      issueTitle: context.issueTitle,
    })
    const body = buildDeterministicPullRequestBody(context.githubIssueNumber)
    return yield* github
      .createDraftPullRequest(
        { owner: githubOwner, name: githubRepo },
        {
          headRefName: branch,
          title,
          body,
        },
      )
      .pipe(
        Effect.map((pullRequestNumber) => ({
          ok: true as const,
          pullRequestNumber,
        })),
        Effect.catch((cause) =>
          Effect.succeed({
            ok: false as const,
            diagnostics: boundDiagnostics(
              `createDraftPullRequest failed: ${errorMessage(cause)}`,
            ),
          }),
        ),
      )
  })

const resolveRepositoryRecord = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repositories = yield* db.listRepositories.pipe(
      Effect.mapError(
        (cause) =>
          new CreatePrCredentialError({
            repositoryId: context.repositoryId,
            message: "Failed to resolve the Work Item repository",
            cause,
          }),
      ),
    )
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new CreatePrCredentialError({
        repositoryId: context.repositoryId,
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    return repository
  })

/**
 * Production Create PR Lifecycle Step.
 * Looks up an existing open PR for the exact Work Item branch, otherwise
 * pushes (harness credential path) and creates a draft through the harness-owned
 * GitHub service. Continues the Implement Session only when the native path
 * does not establish the postcondition (repair fallback). Success requires
 * resolving the open PR identity for persistence.
 */
export const createPr = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const repository = yield* resolveRepositoryRecord(context)
    const branch = workItemBranchName({
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
      githubIssueNumber: context.githubIssueNumber,
      workItemId: context.workItemId,
    })

    // Reuse an existing exact-branch open PR (also covers Retry / indeterminate).
    // Hard-fail here: without a reliable answer we should not create a duplicate.
    const existing = yield* findExistingOpenPr(
      context,
      repository.githubOwner,
      repository.githubRepo,
      branch,
    )
    if (existing !== null) {
      return {
        pullRequestNumber: existing,
        completion: "native",
      } satisfies CreatePrResult
    }

    const pushTokenName = yield* resolveNativePushTokenName(
      context.repositoryId,
      repository.githubOwner,
      repository.githubRepo,
    )
    const push = yield* attemptNativePush(worktreePath, branch, pushTokenName)
    let nativeDiagnostics: string | null = push.ok ? null : push.diagnostics

    if (push.ok) {
      const created = yield* attemptNativeCreateDraft(
        context,
        repository.githubOwner,
        repository.githubRepo,
        branch,
      )
      if (created.ok) {
        // Soft-verify only: a successful create already establishes identity.
        // Transient lookup failure must not fail the Step Run or drop the number.
        const verified = yield* softFindExistingOpenPr(
          context,
          repository.githubOwner,
          repository.githubRepo,
          branch,
        )
        return {
          pullRequestNumber: verified ?? created.pullRequestNumber,
          completion: "native",
        } satisfies CreatePrResult
      }
      nativeDiagnostics = created.diagnostics
    }

    // Soft re-lookup before agent fallback so an indeterminate create does not
    // duplicate, and so lookup transport errors still allow one repair turn.
    const afterNative = yield* softFindExistingOpenPr(
      context,
      repository.githubOwner,
      repository.githubRepo,
      branch,
    )
    if (afterNative !== null) {
      return {
        pullRequestNumber: afterNative,
        completion: "native",
      } satisfies CreatePrResult
    }

    const auth = yield* resolveAgentTurnGitHubAuth({
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
    }).pipe(
      Effect.mapError((cause) => {
        if (
          cause instanceof AgentTurnGitHubCredentialMissingError ||
          cause instanceof InvalidCapturedAgentBackendError
        ) {
          return new CreatePrCredentialError({
            repositoryId: context.repositoryId,
            message: cause.message,
          })
        }
        return new CreatePrCredentialError({
          repositoryId: context.repositoryId,
          message: "Failed to resolve the repository GitHub credential",
          cause,
        })
      }),
    )

    const sessionId = yield* resolveSessionId(context)
    const diagnostics = boundDiagnostics(
      nativeDiagnostics ??
        "Native Create PR did not establish an open pull request for the Work Item branch",
    )
    const timeout =
      context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.create_pr
    const agentBackend = yield* AgentBackend
    yield* agentBackend
      .continueTurn({
        sessionId,
        prompt: buildCreatePrFallbackPrompt(
          context.githubIssueNumber,
          branch,
          auth,
          diagnostics,
        ),
        cwd: worktreePath,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        timeout,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CreatePrOpenCodeError({
              message: `${agentBackendLabel(context.agentBackend)} failed to create a pull request`,
              worktreePath,
              sessionId,
              cause,
            }),
        ),
      )

    // After fallback, soft-lookup first so a successful create with a flaky
    // required lookup still succeeds; then require the open PR identity.
    const afterFallback = yield* softFindExistingOpenPr(
      context,
      repository.githubOwner,
      repository.githubRepo,
      branch,
    )
    if (afterFallback !== null) {
      return {
        pullRequestNumber: afterFallback,
        completion: "agent_fallback",
      } satisfies CreatePrResult
    }

    const required = yield* Effect.result(
      resolveRequiredOpenPr(
        context,
        repository.githubOwner,
        repository.githubRepo,
        branch,
      ),
    )
    if (required._tag === "Success") {
      return {
        pullRequestNumber: required.success,
        completion: "agent_fallback",
      } satisfies CreatePrResult
    }

    return yield* new CreatePrPostconditionError({
      repositoryId: context.repositoryId,
      message: `No open pull request found for ${repository.githubOwner}/${repository.githubRepo}:${branch} after native attempt and agent fallback`,
      diagnostics,
    })
  })
