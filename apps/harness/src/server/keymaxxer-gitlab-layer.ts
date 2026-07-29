import { Duration, Effect, Layer, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { sanitizeUserFacingText } from "@ready-for-agent/github-service"
import {
  GITLAB_VAULT_METADATA_BUDGET_SECONDS,
  type GitLabHelperOperation,
  GitLabProjectUnavailableError,
  type GitLabReadyLabeledIssue,
  type GitLabRepository,
  GitLabRequestError,
  GitLabService,
  type GitLabServiceShape,
  formatGitLabHelperShellCommand,
  gitlabVaultAccount,
  resolveGitLabHelperChildSpawn,
} from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { ambientGitLabLayer } from "./ambient-gitlab-layer.js"

type GitLabServiceError = GitLabProjectUnavailableError | GitLabRequestError

/**
 * Client-side budget for vault secret metadata before ambient fallback.
 * Shorter than Keymaxxer human-dialog waits so ambient-only Repositories are
 * not stalled for the full unlock/dialog window when Keymaxxer is enabled.
 */
const GITLAB_VAULT_METADATA_BUDGET = Duration.seconds(
  GITLAB_VAULT_METADATA_BUDGET_SECONDS,
)

type VaultSecretProbe =
  | { readonly kind: "secret"; readonly name: string }
  | { readonly kind: "miss" }
  | { readonly kind: "unavailable" }

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)
const RequiredString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim() === "" ? "Expected a non-empty string" : undefined,
    ),
  ),
)
const UrlString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      try {
        new URL(value)
        return undefined
      } catch {
        return "Invalid URL"
      }
    }),
  ),
)

const SerializedIssue = Schema.Struct({
  number: PositiveInt,
  title: RequiredString,
  body: Schema.String,
  url: UrlString,
  createdAt: Schema.DateFromString,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  author: Schema.NullOr(RequiredString),
  hierarchySupported: Schema.Boolean,
  hasChildren: Schema.Boolean,
  parentPosition: Schema.NullOr(NonNegativeInt),
  parent: Schema.NullOr(
    Schema.Struct({
      number: PositiveInt,
      url: UrlString,
      state: Schema.Literals(["OPEN", "CLOSED"]),
      isReadyLabeled: Schema.Boolean,
    }),
  ),
  blockedBy: Schema.Array(
    Schema.Struct({
      number: PositiveInt,
      url: UrlString,
    }),
  ),
  closingPullRequests: Schema.Array(
    Schema.Struct({
      number: PositiveInt,
      repository: RequiredString,
      state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
      isDraft: Schema.Boolean,
    }),
  ),
})

const SerializedIssues = Schema.Array(SerializedIssue)

const SerializedTerminalPrStatusCheck = Schema.Struct({
  externalId: Schema.String,
  name: Schema.String,
  outcome: Schema.Literals(["green", "red"]),
})

const SerializedPrStatusCheckLogFetch = Schema.Union([
  Schema.TaggedStruct("ok", {
    excerpt: Schema.String,
    localPath: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("unavailable", {
    reason: Schema.String,
  }),
])

const SerializedPrStatusCheckDiagnostic = Schema.Struct({
  externalId: Schema.String,
  name: Schema.String,
  source: Schema.Literals(["actions-job", "status", "gitlab-job", "unknown"]),
  htmlUrl: Schema.NullOr(Schema.String),
  logFetch: SerializedPrStatusCheckLogFetch,
})

const SerializedPrStatusCheckDiagnostics = Schema.Array(
  SerializedPrStatusCheckDiagnostic,
)

const SerializedPullRequestCheckStatusFields = {
  mergeability: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  baseRefName: Schema.NullOr(Schema.String),
  headPushedAt: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  isDraft: Schema.NullOr(Schema.Boolean),
} as const

const SerializedPullRequestCheckStatus = Schema.Union([
  Schema.TaggedStruct("pending", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("expected", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("no_checks", {
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("succeeded", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("failed", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
    ...SerializedPullRequestCheckStatusFields,
  }),
  Schema.TaggedStruct("closed", {
    ...SerializedPullRequestCheckStatusFields,
  }),
])

const SerializedPullRequestLifecycleStatus = Schema.Union([
  Schema.TaggedStruct("open", {}),
  Schema.TaggedStruct("merged", {}),
  Schema.TaggedStruct("closed", {}),
  Schema.TaggedStruct("not_found", {}),
])

const SerializedMergePullRequestResult = Schema.Union([
  Schema.TaggedStruct("merged", {}),
  Schema.TaggedStruct("revalidation", {
    reason: Schema.Literals([
      "head_changed",
      "checks_not_green",
      "mergeability_changed",
    ]),
    message: RequiredString,
  }),
  Schema.TaggedStruct("needs_human", {
    reason: Schema.Literals(["closed_unmerged", "merge_rejected"]),
    message: RequiredString,
  }),
])

const decodeOptionalInstant = (value: string | null): Date | null => {
  if (value === null) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed
}

const requestError = (
  repository: GitLabRepository,
  operation: string,
  detail?: string,
) => {
  const cleaned =
    detail === undefined || detail.trim() === ""
      ? ""
      : sanitizeUserFacingText(detail, 300)
  return new GitLabRequestError({
    message:
      cleaned === ""
        ? `Failed to ${operation} for ${repository.projectPath}`
        : `Failed to ${operation} for ${repository.projectPath}: ${cleaned}`,
  })
}

const encodeArgument = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const encodedRepositoryArguments = (repository: GitLabRepository) =>
  [
    encodeArgument(repository.forge),
    encodeArgument(repository.forgeHost),
    encodeArgument(repository.projectPath),
  ] as const

const repositoryUnavailable = (repository: GitLabRepository) =>
  new GitLabProjectUnavailableError(repository)

const parseIssues = (
  stdout: string,
  repository: GitLabRepository,
): Effect.Effect<readonly GitLabReadyLabeledIssue[], GitLabRequestError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(SerializedIssues))(
    stdout,
  ).pipe(
    Effect.mapError(() =>
      requestError(repository, "list Ready-labeled Issues"),
    ),
  )

/**
 * Vault-first GitLab service layer.
 *
 * Precedence (documented on issue #571): a per-Repository Keymaxxer secret
 * (`provider: gitlab`, `account: <forge-host>/<project-path>`) is strictly more
 * specific than ambient `GITLAB_TOKEN` / `glab`. When the vault holds a secret,
 * every Forge operation runs through a token-injected helper process so the raw
 * token never enters the Harness. When no secret exists, ambient credentials
 * remain the fallback.
 */
export const keymaxxerGitLabLayer = (options: {
  readonly workspaceRoot: string
  readonly environment?: Partial<Record<string, string | undefined>>
  /** Test injection: ambient token resolver / service factories. */
  readonly resolveToken?: (forgeHost: string) => Promise<string>
  readonly makeService?: (token: string) => GitLabServiceShape
  readonly makeAnonymousService?: () => GitLabServiceShape
  /** Override vault metadata budget (tests). Defaults to {@link GITLAB_VAULT_METADATA_BUDGET}. */
  readonly vaultMetadataBudget?: Duration.Duration
}): Layer.Layer<
  GitLabService,
  never,
  KeymaxxerService | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    GitLabService,
    Effect.gen(function* () {
      const keymaxxer = yield* KeymaxxerService
      const vaultBudget =
        options.vaultMetadataBudget ?? GITLAB_VAULT_METADATA_BUDGET
      // Build ambient fallback inside this layer so vault-first can delegate
      // when no per-Repository secret exists (without leaking the raw vault token).
      const ambient = yield* GitLabService.pipe(
        Effect.provide(
          ambientGitLabLayer({
            workspaceRoot: options.workspaceRoot,
            environment: options.environment,
            resolveToken: options.resolveToken,
            makeService: options.makeService,
            makeAnonymousService: options.makeAnonymousService,
          }),
        ),
      )

      const ensureToken = Effect.fn("KeymaxxerGitLab.ensureToken")(
        (repository: GitLabRepository) =>
          keymaxxer.findSecret({
            provider: "gitlab",
            account: gitlabVaultAccount(repository),
          }),
      )

      /**
       * Budgeted vault metadata probe.
       * - secret: vault holds a named secret
       * - miss: vault answered; no secret for this account
       * - unavailable: timeout or Keymaxxer error (do not treat as miss for
       *   polling membership — vault-only repos must not drop schedules)
       */
      const probeVaultSecret = Effect.fn("KeymaxxerGitLab.probeVaultSecret")(
        (repository: GitLabRepository): Effect.Effect<VaultSecretProbe> =>
          ensureToken(repository).pipe(
            Effect.timeout(vaultBudget),
            Effect.map(
              (name): VaultSecretProbe =>
                name === null ? { kind: "miss" } : { kind: "secret", name },
            ),
            Effect.catchTags({
              TimeoutError: (): Effect.Effect<VaultSecretProbe> =>
                Effect.succeed({ kind: "unavailable" }),
              KeymaxxerError: (): Effect.Effect<VaultSecretProbe> =>
                Effect.succeed({ kind: "unavailable" }),
            }),
          ),
      )

      const runGitLabCommand = Effect.fn("KeymaxxerGitLab.runCommand")(
        (tokenName: string, command: string) =>
          keymaxxer.runWithSecrets({
            // Alias the named vault secret as GITLAB_TOKEN for GitLabServiceLive.
            command: `GITLAB_TOKEN="$${tokenName}" ${command}`,
            cwd: options.workspaceRoot,
            secrets: [tokenName],
            timeoutMs: 60_000,
          }),
      )

      const runGitLabBin = Effect.fn("KeymaxxerGitLab.runHelper")(
        (
          tokenName: string,
          operation: GitLabHelperOperation,
          args: readonly string[],
        ) =>
          runGitLabCommand(
            tokenName,
            formatGitLabHelperShellCommand(
              resolveGitLabHelperChildSpawn({ operation, args }),
            ),
          ),
      )

      const runVaultHelper = <A>(
        repository: GitLabRepository,
        tokenName: string,
        operation: GitLabHelperOperation,
        decode: (stdout: string) => Effect.Effect<A, GitLabServiceError>,
        operationLabel: string,
        extraArgs: readonly string[] = [],
      ): Effect.Effect<A, GitLabServiceError> =>
        Effect.gen(function* () {
          const [forge, forgeHost, projectPath] =
            encodedRepositoryArguments(repository)
          const result = yield* runGitLabBin(tokenName, operation, [
            forge,
            forgeHost,
            projectPath,
            ...extraArgs,
          ])
          if (result.exitCode === 2) {
            return yield* repositoryUnavailable(repository)
          }
          if (result.exitCode !== 0) {
            return yield* requestError(
              repository,
              operationLabel,
              result.stderr || result.stdout,
            )
          }
          return yield* decode(result.stdout)
        }).pipe(
          Effect.catchTag("KeymaxxerError", () =>
            Effect.fail(requestError(repository, operationLabel)),
          ),
        )

      const withVaultOrAmbient = <A>(
        repository: GitLabRepository,
        whenVault: (tokenName: string) => Effect.Effect<A, GitLabServiceError>,
        whenAmbient: (
          service: GitLabServiceShape,
        ) => Effect.Effect<A, GitLabServiceError>,
      ): Effect.Effect<A, GitLabServiceError> =>
        Effect.gen(function* () {
          // Vault lookup is budgeted so unlock dialog / hung MCP cannot block
          // ambient-only Repositories for the full human-dialog window.
          // Miss or unavailable → ambient for ops. Fail closed only after a
          // secret name is known and helper execution fails.
          const probe = yield* probeVaultSecret(repository)
          if (probe.kind === "secret") {
            return yield* whenVault(probe.name)
          }
          return yield* whenAmbient(ambient)
        })

      const service: GitLabServiceShape = {
        verifyProject: Effect.fn("KeymaxxerGitLab.verifyProject")(
          (repository) =>
            withVaultOrAmbient(
              repository,
              (tokenName) =>
                runVaultHelper(
                  repository,
                  tokenName,
                  "verify-project",
                  (stdout) =>
                    stdout.trim() === "" || stdout.trim() === "ok"
                      ? Effect.void
                      : Effect.fail(
                          requestError(
                            repository,
                            "verify GitLab project",
                            stdout,
                          ),
                        ),
                  "verify GitLab project",
                ),
              (ambientService) => ambientService.verifyProject(repository),
            ),
        ),
        getAuthenticatedUserLogin: Effect.fn(
          "KeymaxxerGitLab.getAuthenticatedUserLogin",
        )((repository) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "get-authenticated-user-login",
                (stdout) => {
                  const login = stdout.trim()
                  if (login === "") {
                    return Effect.fail(
                      requestError(
                        repository,
                        "resolve authenticated GitLab user",
                        "empty login",
                      ),
                    )
                  }
                  return Effect.succeed(login)
                },
                "resolve authenticated GitLab user",
              ),
            (ambientService) =>
              ambientService.getAuthenticatedUserLogin(repository),
          ),
        ),
        listReadyIssues: Effect.fn("KeymaxxerGitLab.listReadyIssues")(
          (repository) =>
            withVaultOrAmbient(
              repository,
              (tokenName) =>
                runVaultHelper(
                  repository,
                  tokenName,
                  "list-ready-issues",
                  (stdout) => parseIssues(stdout, repository),
                  "list Ready-labeled Issues",
                ),
              (ambientService) => ambientService.listReadyIssues(repository),
            ),
        ),
        hasCredentials: Effect.fn("KeymaxxerGitLab.hasCredentials")(
          (repository) =>
            Effect.gen(function* () {
              const probe = yield* probeVaultSecret(repository)
              if (probe.kind === "secret") return true
              // Temporary Keymaxxer hang/lock is not a clean miss: fail open so
              // job-worker polling membership does not drop vault-only repos.
              if (probe.kind === "unavailable") return true
              return yield* ambient.hasAmbientCredentials(repository)
            }),
        ),
        hasAmbientCredentials: Effect.fn(
          "KeymaxxerGitLab.hasAmbientCredentials",
        )((repository) => ambient.hasAmbientCredentials(repository)),
        getOpenPullRequestNumber: Effect.fn(
          "KeymaxxerGitLab.getOpenPullRequestNumber",
        )((repository, headRefName) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "get-open-pull-request-number",
                (stdout) => {
                  const number = Number(stdout.trim())
                  if (!Number.isSafeInteger(number) || number <= 0) {
                    return Effect.fail(
                      requestError(
                        repository,
                        "decode open pull request number",
                        stdout,
                      ),
                    )
                  }
                  return Effect.succeed(number)
                },
                "get open pull request number",
                [encodeArgument(headRefName)],
              ),
            (ambientService) =>
              ambientService.getOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        findOpenPullRequestNumber: Effect.fn(
          "KeymaxxerGitLab.findOpenPullRequestNumber",
        )((repository, headRefName) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "find-open-pull-request-number",
                (stdout) => {
                  const trimmed = stdout.trim()
                  if (trimmed === "") return Effect.succeed(null)
                  const number = Number(trimmed)
                  if (!Number.isSafeInteger(number) || number <= 0) {
                    return Effect.fail(
                      requestError(
                        repository,
                        "decode open pull request number",
                        stdout,
                      ),
                    )
                  }
                  return Effect.succeed(number)
                },
                "find open pull request number",
                [encodeArgument(headRefName)],
              ),
            (ambientService) =>
              ambientService.findOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        createDraftPullRequest: Effect.fn(
          "KeymaxxerGitLab.createDraftPullRequest",
        )((repository, input) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "create-draft-pull-request",
                (stdout) => {
                  const number = Number(stdout.trim())
                  if (!Number.isSafeInteger(number) || number <= 0) {
                    return Effect.fail(
                      requestError(
                        repository,
                        "decode created draft pull request number",
                        stdout,
                      ),
                    )
                  }
                  return Effect.succeed(number)
                },
                "create draft pull request",
                [
                  encodeArgument(
                    JSON.stringify({
                      headRefName: input.headRefName,
                      title: input.title,
                      body: input.body,
                      ...(input.baseRefName === undefined
                        ? {}
                        : { baseRefName: input.baseRefName }),
                    }),
                  ),
                ],
              ),
            (ambientService) =>
              ambientService.createDraftPullRequest(repository, input),
          ),
        ),
        updateOpenDraftPullRequestCopy: Effect.fn(
          "KeymaxxerGitLab.updateOpenDraftPullRequestCopy",
        )((repository, headRefName, input) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "update-open-draft-pull-request-copy",
                (stdout) => {
                  const trimmed = stdout.trim()
                  if (trimmed === "") return Effect.succeed(null)
                  const number = Number(trimmed)
                  if (!Number.isSafeInteger(number) || number <= 0) {
                    return Effect.fail(
                      requestError(
                        repository,
                        "decode updated draft pull request number",
                        stdout,
                      ),
                    )
                  }
                  return Effect.succeed(number)
                },
                "update open draft pull request copy",
                [
                  encodeArgument(headRefName),
                  encodeArgument(
                    JSON.stringify({ title: input.title, body: input.body }),
                  ),
                ],
              ),
            (ambientService) =>
              ambientService.updateOpenDraftPullRequestCopy(
                repository,
                headRefName,
                input,
              ),
          ),
        ),
        countOpenNonDraftPullRequests: Effect.fn(
          "KeymaxxerGitLab.countOpenNonDraftPullRequests",
        )((repository) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "count-open-non-draft-pull-requests",
                (stdout) => {
                  const count = Number(stdout.trim())
                  if (!Number.isSafeInteger(count) || count < 0) {
                    return Effect.fail(
                      requestError(
                        repository,
                        "decode open non-draft pull request count",
                        stdout,
                      ),
                    )
                  }
                  return Effect.succeed(count)
                },
                "count open non-draft pull requests",
              ),
            (ambientService) =>
              ambientService.countOpenNonDraftPullRequests(repository),
          ),
        ),
        getPullRequestCheckStatus: Effect.fn(
          "KeymaxxerGitLab.getPullRequestCheckStatus",
        )((repository, headRefName) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "get-pr-check-status",
                (stdout) =>
                  Schema.decodeUnknownEffect(
                    Schema.fromJsonString(SerializedPullRequestCheckStatus),
                  )(stdout).pipe(
                    Effect.map((status) => ({
                      ...status,
                      headPushedAt: decodeOptionalInstant(status.headPushedAt),
                      createdAt: decodeOptionalInstant(status.createdAt),
                    })),
                    Effect.mapError(() =>
                      requestError(
                        repository,
                        "decode pull request check status",
                        stdout,
                      ),
                    ),
                  ),
                "get pull request check status",
                [encodeArgument(headRefName)],
              ),
            (ambientService) =>
              ambientService.getPullRequestCheckStatus(repository, headRefName),
          ),
        ),
        getPrStatusCheckDiagnostics: Effect.fn(
          "KeymaxxerGitLab.getPrStatusCheckDiagnostics",
        )((repository, checks, options = {}) =>
          withVaultOrAmbient(
            repository,
            (tokenName) => {
              const checksArg = encodeArgument(
                JSON.stringify(
                  checks.map((check) => ({
                    externalId: check.externalId,
                    name: check.name,
                  })),
                ),
              )
              const logDirectory =
                typeof options.logDirectory === "string" &&
                options.logDirectory.trim() !== ""
                  ? encodeArgument(options.logDirectory)
                  : ""
              return runVaultHelper(
                repository,
                tokenName,
                "get-pr-status-check-diagnostics",
                (stdout) =>
                  Schema.decodeUnknownEffect(
                    Schema.fromJsonString(SerializedPrStatusCheckDiagnostics),
                  )(stdout).pipe(
                    Effect.mapError(() =>
                      requestError(
                        repository,
                        "decode PR Status Check diagnostics",
                        stdout,
                      ),
                    ),
                  ),
                "get PR Status Check diagnostics",
                logDirectory === "" ? [checksArg] : [checksArg, logDirectory],
              )
            },
            (ambientService) =>
              ambientService.getPrStatusCheckDiagnostics(
                repository,
                checks,
                options,
              ),
          ),
        ),
        markPullRequestReadyForReview: Effect.fn(
          "KeymaxxerGitLab.markPullRequestReadyForReview",
        )((repository, headRefName) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "mark-pr-ready-for-review",
                () => Effect.void,
                "mark pull request ready for review",
                [encodeArgument(headRefName)],
              ),
            (ambientService) =>
              ambientService.markPullRequestReadyForReview(
                repository,
                headRefName,
              ),
          ),
        ),
        getPullRequestLifecycleStatus: Effect.fn(
          "KeymaxxerGitLab.getPullRequestLifecycleStatus",
        )((repository, headRefName) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "get-pr-lifecycle-status",
                (stdout) =>
                  Schema.decodeUnknownEffect(
                    Schema.fromJsonString(SerializedPullRequestLifecycleStatus),
                  )(stdout).pipe(
                    Effect.mapError(() =>
                      requestError(
                        repository,
                        "decode pull request lifecycle status",
                        stdout,
                      ),
                    ),
                  ),
                "get pull request lifecycle status",
                [encodeArgument(headRefName)],
              ),
            (ambientService) =>
              ambientService.getPullRequestLifecycleStatus(
                repository,
                headRefName,
              ),
          ),
        ),
        mergePullRequest: Effect.fn("KeymaxxerGitLab.mergePullRequest")(
          (repository, headRefName) =>
            withVaultOrAmbient(
              repository,
              (tokenName) =>
                runVaultHelper(
                  repository,
                  tokenName,
                  "merge-pull-request",
                  (stdout) =>
                    Schema.decodeUnknownEffect(
                      Schema.fromJsonString(SerializedMergePullRequestResult),
                    )(stdout).pipe(
                      Effect.mapError(() =>
                        requestError(
                          repository,
                          "decode merge pull request result",
                          stdout,
                        ),
                      ),
                    ),
                  "merge pull request",
                  [encodeArgument(headRefName)],
                ),
              (ambientService) =>
                ambientService.mergePullRequest(repository, headRefName),
            ),
        ),
        ensureIssueCompletedWithSummary: Effect.fn(
          "KeymaxxerGitLab.ensureIssueCompletedWithSummary",
        )((repository, issueNumber, workItemId, summaryMarkdown) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "ensure-issue-completed-with-summary",
                () => Effect.void,
                "ensure issue completed with summary",
                [
                  encodeArgument(String(issueNumber)),
                  encodeArgument(workItemId),
                  encodeArgument(summaryMarkdown),
                ],
              ),
            (ambientService) =>
              ambientService.ensureIssueCompletedWithSummary(
                repository,
                issueNumber,
                workItemId,
                summaryMarkdown,
              ),
          ),
        ),
        closeOpenPullRequestsForBranch: Effect.fn(
          "KeymaxxerGitLab.closeOpenPullRequestsForBranch",
        )((repository, headRefName) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              runVaultHelper(
                repository,
                tokenName,
                "close-open-pull-requests-for-branch",
                () => Effect.void,
                "close open pull requests for branch",
                [encodeArgument(headRefName)],
              ),
            (ambientService) =>
              ambientService.closeOpenPullRequestsForBranch(
                repository,
                headRefName,
              ),
          ),
        ),
        deleteBranch: Effect.fn("KeymaxxerGitLab.deleteBranch")(
          (repository, branchName) =>
            withVaultOrAmbient(
              repository,
              (tokenName) =>
                runVaultHelper(
                  repository,
                  tokenName,
                  "delete-branch",
                  () => Effect.void,
                  "delete branch",
                  [encodeArgument(branchName)],
                ),
              (ambientService) =>
                ambientService.deleteBranch(repository, branchName),
            ),
        ),
      }
      return service
    }),
  )
