import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { DbService, type RepositoryRecord } from "@ready-for-agent/db-service"
import {
  type GitHubRepository,
  GitHubService,
  isGitHubThrottledError,
} from "@ready-for-agent/github-service"
import {
  type GitLabRepository,
  GitLabService,
  resolveGlabHostToken,
} from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  AgentTurnForgeCredentialMissingError,
  InvalidCapturedAgentBackendError,
  agentTurnForgeCredentialGuidance,
  resolveAgentTurnForgeAuth,
} from "./agent-turn-forge-auth.js"
import { CurrentStepRun } from "./agent-turn-limiter.js"
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
  type PublicationCopy,
  buildCreatePrFallbackPromptWithCopy,
  normalizePublicationCopy,
  publicationCopyFromCommitMessage,
} from "./publication-copy.js"
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
  /** Canonical copy used for this Create PR (may be HEAD-seeded). */
  readonly publicationTitle: string
  readonly publicationBody: string
}

const toCreatePrResult = (
  pullRequestNumber: number,
  completion: LifecycleStepCompletion,
  copy: PublicationCopy,
): CreatePrResult => ({
  pullRequestNumber,
  completion,
  publicationTitle: copy.title,
  publicationBody: copy.body,
})

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

/**
 * @deprecated Prefer Work Item publicationTitle/Body. Kept for test fixtures that
 * still assert the pre-#546 Issue-title template shape.
 */
export const buildDeterministicPullRequestTitle = (input: {
  readonly issueNumber: number
  readonly issueTitle: string | null
}): string => {
  if (input.issueTitle === null || input.issueTitle.trim() === "") {
    return `Implement #${input.issueNumber}`
  }
  return input.issueTitle.trim()
}

/**
 * @deprecated Prefer Work Item publicationTitle/Body. Kept for test fixtures that
 * still assert the pre-#546 generic body shape.
 */
export const buildDeterministicPullRequestBody = (
  issueNumber: number,
): string =>
  [
    `Automated draft pull request for GitHub issue #${issueNumber}.`,
    "",
    `Closes #${issueNumber}`,
  ].join("\n")

/**
 * Soft lookup of an open PR/MR (null when none). Transport/API failures
 * surface as CreatePrLookupError so callers can choose hard-fail vs soft-null.
 */
const findExistingOpenPr = (
  context: LifecycleStepContext,
  repository: RepositoryRecord,
  branch: string,
) =>
  Effect.gen(function* () {
    if (repository.forge === "gitlab") {
      const gitlab = yield* GitLabService
      return yield* gitlab
        .findOpenPullRequestNumber(toGitLabRepository(repository), branch)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CreatePrLookupError({
                repositoryId: context.repositoryId,
                message: `Failed to look up an open merge request for ${repository.projectPath}:${branch}`,
                cause,
              }),
          ),
        )
    }
    const github = yield* GitHubService
    return yield* github
      .findOpenPullRequestNumber(toGitHubRepository(repository), branch)
      .pipe(
        Effect.mapError((cause) =>
          isGitHubThrottledError(cause)
            ? cause
            : new CreatePrLookupError({
                repositoryId: context.repositoryId,
                message: `Failed to look up an open pull request for ${repository.projectPath}:${branch}`,
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
  repository: RepositoryRecord,
  branch: string,
) =>
  findExistingOpenPr(context, repository, branch).pipe(
    Effect.catch((error) =>
      isGitHubThrottledError(error) ? Effect.fail(error) : Effect.succeed(null),
    ),
  )

const resolveRequiredOpenPr = (
  context: LifecycleStepContext,
  repository: RepositoryRecord,
  branch: string,
) =>
  Effect.gen(function* () {
    if (repository.forge === "gitlab") {
      const gitlab = yield* GitLabService
      return yield* gitlab
        .getOpenPullRequestNumber(toGitLabRepository(repository), branch)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CreatePrLookupError({
                repositoryId: context.repositoryId,
                message: `Failed to resolve the open merge request for ${repository.projectPath}:${branch}`,
                cause,
              }),
          ),
        )
    }
    const github = yield* GitHubService
    return yield* github
      .getOpenPullRequestNumber(toGitHubRepository(repository), branch)
      .pipe(
        Effect.mapError((cause) =>
          isGitHubThrottledError(cause)
            ? cause
            : new CreatePrLookupError({
                repositoryId: context.repositoryId,
                message: `Failed to resolve the open pull request for ${repository.projectPath}:${branch}`,
                cause,
              }),
        ),
      )
  })

/**
 * Vault secret name for native push when Keymaxxer is enabled; null for ambient
 * (Keymaxxer disabled) or when no repository secret is configured.
 */
const resolveNativePushTokenName = (repository: RepositoryRecord) =>
  Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    if (keymaxxer.enabled === false) {
      return null
    }
    const isGitLab = repository.forge === "gitlab"
    return yield* keymaxxer
      .findSecret({
        provider: isGitLab ? "gitlab" : "github",
        account: isGitLab
          ? `${repository.forgeHost}/${repository.projectPath}`
          : repository.projectPath,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CreatePrCredentialError({
              repositoryId: repository.id,
              message: `Failed to resolve the repository ${isGitLab ? "GitLab" : "GitHub"} credential for native push`,
              cause,
            }),
        ),
      )
  })

const gitlabHttpsRemoteUrl = (repository: RepositoryRecord): string =>
  `https://${repository.forgeHost}/${repository.projectPath}.git`

/**
 * Resolve ambient GitLab token for HTTPS push (Keymaxxer path unavailable).
 * Prefers GITLAB_TOKEN, then host-authenticated glab via shared helper.
 */
const resolveAmbientGitLabToken = (forgeHost: string) =>
  Effect.gen(function* () {
    const fromEnv = process.env.GITLAB_TOKEN?.trim()
    if (fromEnv !== undefined && fromEnv !== "") {
      return fromEnv
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* resolveGlabHostToken({ forgeHost, spawner })
  })

/**
 * Push the Work Item branch via the harness credential path when a vault
 * secret is available (Keymaxxer runWithSecrets + HTTPS Authorization header).
 * Ambient GitHub uses plain git push to origin. Ambient GitLab pushes over
 * HTTPS to the Forge Host with token auth and never modifies origin.
 */
const attemptNativePush = (
  worktreePath: string,
  branch: string,
  repository: RepositoryRecord,
  tokenName: string | null,
) =>
  Effect.gen(function* () {
    if (repository.forge === "gitlab") {
      return yield* attemptGitLabHttpsPush(
        worktreePath,
        branch,
        repository,
        tokenName,
      )
    }

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

/**
 * Push to https://<forge-host>/<project-path>.git with token auth. Leaves the
 * operator's SSH origin untouched (never git remote set-url).
 */
const attemptGitLabHttpsPush = (
  worktreePath: string,
  branch: string,
  repository: RepositoryRecord,
  tokenName: string | null,
) =>
  Effect.gen(function* () {
    const remoteUrl = gitlabHttpsRemoteUrl(repository)
    const host = repository.forgeHost
    const refspec = `${branch}:${branch}`

    if (tokenName !== null) {
      const keymaxxer = yield* KeymaxxerService
      // Basic auth: username oauth2, password = token (GitLab HTTPS git).
      // Expand the vault secret inside the Keymaxxer child, then base64.
      // Use a real assignment + `&&` — not a simple-command prefix assignment
      // (`BASIC=… git … $BASIC`), which bash does not apply to later-word
      // expansion (same gotcha documented for the GitHub bearer path above).
      const command = [
        `BASIC="$(printf 'oauth2:%s' "$${tokenName}" | (base64 -w0 2>/dev/null || base64 | tr -d '\\n'))"`,
        "&&",
        "git",
        "-C",
        shellQuote(worktreePath),
        "-c",
        `"http.https://${host}/.extraheader=Authorization: Basic $BASIC"`,
        "push",
        shellQuote(remoteUrl),
        shellQuote(refspec),
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
            `credentialed GitLab HTTPS push failed (exit ${result.exitCode})\n${output}`,
          ),
        }
      }
      return { ok: true as const }
    }

    const ambientToken = yield* resolveAmbientGitLabToken(host)
    if (ambientToken === null) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `No ambient GitLab token available for HTTPS push to ${remoteUrl} (set GITLAB_TOKEN or authenticate glab for ${host})`,
        ),
      }
    }

    const basic = Buffer.from(`oauth2:${ambientToken}`, "utf8").toString(
      "base64",
    )
    const push = yield* runGitInWorktree(worktreePath, [
      "-c",
      `http.https://${host}/.extraheader=Authorization: Basic ${basic}`,
      "push",
      remoteUrl,
      refspec,
    ])
    if (push.exitCode !== 0) {
      return {
        ok: false as const,
        diagnostics: boundDiagnostics(
          `GitLab HTTPS push failed (exit ${push.exitCode})\n${push.output}`,
        ),
      }
    }
    return { ok: true as const }
  })

const attemptNativeCreateDraft = (
  repository: RepositoryRecord,
  branch: string,
  copy: PublicationCopy,
) =>
  Effect.gen(function* () {
    if (repository.forge === "gitlab") {
      const gitlab = yield* GitLabService
      return yield* gitlab
        .createDraftPullRequest(toGitLabRepository(repository), {
          headRefName: branch,
          title: copy.title,
          body: copy.body,
        })
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
    }
    const github = yield* GitHubService
    return yield* github
      .createDraftPullRequest(toGitHubRepository(repository), {
        headRefName: branch,
        title: copy.title,
        body: copy.body,
      })
      .pipe(
        Effect.map((pullRequestNumber) => ({
          ok: true as const,
          pullRequestNumber,
        })),
        Effect.catch((cause) =>
          isGitHubThrottledError(cause)
            ? Effect.fail(cause)
            : Effect.succeed({
                ok: false as const,
                diagnostics: boundDiagnostics(
                  `createDraftPullRequest failed: ${errorMessage(cause)}`,
                ),
              }),
        ),
      )
  })

/**
 * Soft-persist publication copy when Create PR seeds from HEAD (in-flight
 * upgrade). Soft-fails on SQL/update errors; unit tests either provide SqlClient
 * or skip the seed path (pre-set publication fields).
 */
const softPersistPublicationCopy = (
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
      Effect.logWarning(
        "Failed to persist publication copy mid-Create PR seed",
        { error, workItemId },
      ),
    ),
    Effect.asVoid,
  )

const softReconcileDraftCopy = (
  repository: RepositoryRecord,
  branch: string,
  copy: PublicationCopy,
  pullRequestNumber: number,
) =>
  Effect.gen(function* () {
    if (repository.forge === "gitlab") {
      const gitlab = yield* GitLabService
      yield* gitlab
        .updateOpenDraftPullRequestCopy(
          toGitLabRepository(repository),
          branch,
          {
            title: copy.title,
            body: copy.body,
          },
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Failed to reconcile draft MR title/body to canonical publication copy; reusing open MR",
              {
                pullRequestNumber,
                cause,
              },
            ).pipe(Effect.as(pullRequestNumber)),
          ),
        )
      return
    }
    const github = yield* GitHubService
    yield* github
      .updateOpenDraftPullRequestCopy(toGitHubRepository(repository), branch, {
        title: copy.title,
        body: copy.body,
      })
      .pipe(
        Effect.catch((cause) =>
          isGitHubThrottledError(cause)
            ? Effect.fail(cause)
            : Effect.logWarning(
                "Failed to reconcile draft PR title/body to canonical publication copy; reusing open PR",
                {
                  pullRequestNumber,
                  cause,
                },
              ).pipe(Effect.as(pullRequestNumber)),
        ),
      )
  })

const toGitHubRepository = (
  repository: RepositoryRecord,
): GitHubRepository => ({
  forge: repository.forge,
  forgeHost: repository.forgeHost,
  projectPath: repository.projectPath,
})

const toGitLabRepository = (
  repository: RepositoryRecord,
): GitLabRepository => ({
  forge: repository.forge,
  forgeHost: repository.forgeHost,
  projectPath: repository.projectPath,
})

const resolvePublicationCopyForCreatePr = (
  context: LifecycleStepContext,
  worktreePath: string,
) =>
  Effect.gen(function* () {
    const title = context.publicationTitle?.trim() ?? ""
    const body = context.publicationBody?.trim() ?? ""
    if (title !== "" && body !== "") {
      const normalized = normalizePublicationCopy(
        { title, body },
        context.issueNumber,
      )
      if (normalized !== null) {
        return normalized
      }
      return { title, body } satisfies PublicationCopy
    }

    // In-flight compatibility: seed from the Work Item commit when fields are absent.
    const head = yield* runGitInWorktree(worktreePath, [
      "log",
      "-1",
      "--pretty=%B",
    ])
    if (head.exitCode === 0) {
      const seeded = publicationCopyFromCommitMessage(
        head.stdout,
        context.issueNumber,
      )
      if (seeded !== null) {
        yield* softPersistPublicationCopy(context.workItemId, seeded)
        return seeded
      }
    }

    return yield* new CreatePrPostconditionError({
      repositoryId: context.repositoryId,
      message:
        "Create PR requires canonical publication copy from Commit (publication_title/body). None was persisted and the head commit message could not be seeded.",
    })
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
 * Looks up an existing open PR/MR for the exact Work Item branch (reconciling
 * draft title/body to canonical copy), otherwise pushes (harness credential
 * path) and creates a draft through the harness-owned Forge service with the
 * same publication copy as Commit. Continues the Implement Session only when
 * the native path does not establish the postcondition (repair fallback).
 * Success requires resolving the open PR/MR identity for persistence.
 */
export const createPr = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const repository = yield* resolveRepositoryRecord(context)
    const branch = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })
    const copy = yield* resolvePublicationCopyForCreatePr(context, worktreePath)

    // Reuse an existing exact-branch open PR/MR (also covers Retry / indeterminate).
    // Hard-fail only on lookup: without a reliable answer we must not create a
    // duplicate. Draft title/body reconcile is best-effort and must not fail
    // the step when an open PR already exists.
    const existing = yield* findExistingOpenPr(context, repository, branch)
    if (existing !== null) {
      yield* softReconcileDraftCopy(repository, branch, copy, existing)
      return toCreatePrResult(existing, "native", copy)
    }

    const pushTokenName = yield* resolveNativePushTokenName(repository)
    const push = yield* attemptNativePush(
      worktreePath,
      branch,
      repository,
      pushTokenName,
    )
    let nativeDiagnostics: string | null = push.ok ? null : push.diagnostics

    if (push.ok) {
      const created = yield* attemptNativeCreateDraft(repository, branch, copy)
      if (created.ok) {
        // Soft-verify only: a successful create already establishes identity.
        // Transient lookup failure must not fail the Step Run or drop the number.
        const verified = yield* softFindExistingOpenPr(
          context,
          repository,
          branch,
        )
        const pullRequestNumber = verified ?? created.pullRequestNumber
        yield* softReconcileDraftCopy(
          repository,
          branch,
          copy,
          pullRequestNumber,
        )
        return toCreatePrResult(pullRequestNumber, "native", copy)
      }
      nativeDiagnostics = created.diagnostics
    }

    // Soft re-lookup before agent fallback so an indeterminate create does not
    // duplicate, and so lookup transport errors still allow one repair turn.
    const afterNative = yield* softFindExistingOpenPr(
      context,
      repository,
      branch,
    )
    if (afterNative !== null) {
      yield* softReconcileDraftCopy(repository, branch, copy, afterNative)
      return toCreatePrResult(afterNative, "native", copy)
    }

    const auth = yield* resolveAgentTurnForgeAuth(repository).pipe(
      Effect.mapError((cause) => {
        if (
          cause instanceof AgentTurnForgeCredentialMissingError ||
          cause instanceof InvalidCapturedAgentBackendError
        ) {
          return new CreatePrCredentialError({
            repositoryId: context.repositoryId,
            message: cause.message,
          })
        }
        return new CreatePrCredentialError({
          repositoryId: context.repositoryId,
          message: `Failed to resolve the repository ${repository.forge === "github" ? "GitHub" : "GitLab"} credential`,
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
        prompt: buildCreatePrFallbackPromptWithCopy({
          issueNumber: context.issueNumber,
          branch,
          title: copy.title,
          body: copy.body,
          credentialGuidance: agentTurnForgeCredentialGuidance(
            repository,
            auth,
            repository.forge === "github"
              ? "GitHub CLI or API access"
              : "GitLab API or push access",
          ),
          diagnostics,
        }),
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
      repository,
      branch,
    )
    if (afterFallback !== null) {
      yield* softReconcileDraftCopy(repository, branch, copy, afterFallback)
      return toCreatePrResult(afterFallback, "agent_fallback", copy)
    }

    const required = yield* Effect.result(
      resolveRequiredOpenPr(context, repository, branch),
    )
    if (required._tag === "Success") {
      yield* softReconcileDraftCopy(repository, branch, copy, required.success)
      return toCreatePrResult(required.success, "agent_fallback", copy)
    }

    if (isGitHubThrottledError(required.failure)) {
      return yield* required.failure
    }

    return yield* new CreatePrPostconditionError({
      repositoryId: context.repositoryId,
      message: `No open pull request found for ${repository.projectPath}:${branch} after native attempt and agent fallback`,
      diagnostics,
    })
  })
