import { Duration, Effect, Layer, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  GITLAB_VAULT_METADATA_BUDGET_SECONDS,
  type GitLabHelperOperation,
  GitLabProjectUnavailableError,
  type GitLabRepository,
  GitLabRequestError,
  GitLabService,
  type GitLabServiceShape,
  formatGitLabHelperShellCommand,
  gitlabVaultAccount,
  normalizeGitLabForgeHost,
  resolveGitLabHelperChildSpawn,
} from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { ambientGitLabLayer } from "./ambient-gitlab-layer.js"
import {
  SerializedMergePullRequestResult,
  SerializedPrStatusCheckDiagnostics,
  SerializedPullRequestCheckStatus,
  SerializedPullRequestLifecycleStatus,
  encodeArgument,
  encodedRepositoryArguments,
  makeRequestError,
  parseSerializedIssues,
} from "./forge-helper-schemas.js"

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

const requestError = makeRequestError(GitLabRequestError)

const repositoryUnavailable = (repository: GitLabRepository) =>
  new GitLabProjectUnavailableError(repository)

const parseIssues = parseSerializedIssues(requestError)

/** Decode a positive integer from helper stdout (trimmed). */
const decodePositiveInt = (
  stdout: string,
  repository: GitLabRepository,
  describe: string,
): Effect.Effect<number, GitLabRequestError> => {
  const number = Number(stdout.trim())
  if (!Number.isSafeInteger(number) || number <= 0) {
    return Effect.fail(requestError(repository, describe, stdout))
  }
  return Effect.succeed(number)
}

/**
 * Decode a non-negative integer from helper stdout.
 *
 * Intentional forge difference vs GitHub: empty stdout is accepted as `0`
 * (`Number("") === 0`). GitHub's sibling rejects empty body so a blank exit-0
 * count cannot be success-cached as zero. Do not "align" these without a
 * product decision and test updates on both layers.
 */
const decodeNonNegativeInt = (
  stdout: string,
  repository: GitLabRepository,
  describe: string,
): Effect.Effect<number, GitLabRequestError> => {
  const count = Number(stdout.trim())
  if (!Number.isSafeInteger(count) || count < 0) {
    return Effect.fail(requestError(repository, describe, stdout))
  }
  return Effect.succeed(count)
}

/**
 * Decode a positive integer, or null when stdout is empty.
 * GitLab helpers emit empty stdout (not the string `"null"`) for a miss.
 */
const decodeNullableInt = (
  stdout: string,
  repository: GitLabRepository,
  describe: string,
): Effect.Effect<number | null, GitLabRequestError> => {
  const trimmed = stdout.trim()
  if (trimmed === "") {
    return Effect.succeed(null)
  }
  const number = Number(trimmed)
  if (!Number.isSafeInteger(number) || number <= 0) {
    return Effect.fail(requestError(repository, describe, stdout))
  }
  return Effect.succeed(number)
}

const decodeVoid = (_stdout: string): Effect.Effect<void, never> => Effect.void

const decodeNonEmptyTrimmed = (
  stdout: string,
  repository: GitLabRepository,
  describe: string,
  emptyDetail: string,
): Effect.Effect<string, GitLabRequestError> => {
  const value = stdout.trim()
  if (value === "") {
    return Effect.fail(requestError(repository, describe, emptyDetail))
  }
  return Effect.succeed(value)
}

const decodeJson =
  <A, I>(
    schema: Schema.Codec<A, I>,
    repository: GitLabRepository,
    describe: string,
  ) =>
  (stdout: string): Effect.Effect<A, GitLabRequestError> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout).pipe(
      Effect.mapError(() => requestError(repository, describe, stdout)),
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

      /**
       * Shared Keymaxxer helper invocation once a vault secret name is known:
       * repository arg encoding, exit-code mapping, stdout decode, and
       * KeymaxxerError → requestError. Callers supply operation, args, and a
       * decoder (token name comes from {@link withVaultOrAmbient}).
       */
      const callHelper = <A>(input: {
        readonly operation: GitLabHelperOperation
        readonly repository: GitLabRepository
        readonly tokenName: string
        readonly describe: string
        readonly args?: readonly string[]
        readonly decode: (
          stdout: string,
        ) => Effect.Effect<A, GitLabServiceError>
      }): Effect.Effect<A, GitLabServiceError> =>
        Effect.gen(function* () {
          const [forge, forgeHost, projectPath] = encodedRepositoryArguments(
            input.repository,
          )
          const result = yield* runGitLabBin(input.tokenName, input.operation, [
            forge,
            forgeHost,
            projectPath,
            ...(input.args ?? []),
          ])
          if (result.exitCode === 2) {
            return yield* repositoryUnavailable(input.repository)
          }
          if (result.exitCode !== 0) {
            return yield* requestError(
              input.repository,
              input.describe,
              result.stderr || result.stdout,
            )
          }
          return yield* input.decode(result.stdout)
        }).pipe(
          Effect.catchTag("KeymaxxerError", () =>
            Effect.fail(requestError(input.repository, input.describe)),
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
                callHelper({
                  operation: "verify-project",
                  repository,
                  tokenName,
                  describe: "verify GitLab project",
                  decode: (stdout) => {
                    const trimmed = stdout.trim()
                    // Legacy helpers printed "ok"; treat that as "no host change".
                    if (trimmed === "" || trimmed === "ok") {
                      return Effect.succeed(repository)
                    }
                    try {
                      const parsed = JSON.parse(trimmed) as {
                        readonly forge?: string
                        readonly forgeHost?: string
                        readonly projectPath?: string
                      }
                      if (
                        typeof parsed.forgeHost !== "string" ||
                        parsed.forgeHost.trim() === "" ||
                        typeof parsed.projectPath !== "string" ||
                        parsed.projectPath.trim() === ""
                      ) {
                        return Effect.fail(
                          requestError(
                            repository,
                            "verify GitLab project",
                            stdout,
                          ),
                        )
                      }
                      return Effect.succeed({
                        forge:
                          typeof parsed.forge === "string" &&
                          parsed.forge.trim() !== ""
                            ? parsed.forge
                            : repository.forge,
                        forgeHost: normalizeGitLabForgeHost(parsed.forgeHost),
                        projectPath: parsed.projectPath.trim(),
                      })
                    } catch {
                      return Effect.fail(
                        requestError(
                          repository,
                          "verify GitLab project",
                          stdout,
                        ),
                      )
                    }
                  },
                }),
              (ambientService) => ambientService.verifyProject(repository),
            ),
        ),
        getAuthenticatedUserLogin: Effect.fn(
          "KeymaxxerGitLab.getAuthenticatedUserLogin",
        )((repository) =>
          withVaultOrAmbient(
            repository,
            (tokenName) =>
              callHelper({
                operation: "get-authenticated-user-login",
                repository,
                tokenName,
                describe: "resolve authenticated GitLab user",
                decode: (stdout) =>
                  decodeNonEmptyTrimmed(
                    stdout,
                    repository,
                    "resolve authenticated GitLab user",
                    "empty login",
                  ),
              }),
            (ambientService) =>
              ambientService.getAuthenticatedUserLogin(repository),
          ),
        ),
        listReadyIssues: Effect.fn("KeymaxxerGitLab.listReadyIssues")(
          (repository) =>
            withVaultOrAmbient(
              repository,
              (tokenName) =>
                callHelper({
                  operation: "list-ready-issues",
                  repository,
                  tokenName,
                  describe: "list Ready-labeled Issues",
                  decode: (stdout) => parseIssues(stdout, repository),
                }),
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
              callHelper({
                operation: "get-open-pull-request-number",
                repository,
                tokenName,
                describe: "get open pull request number",
                args: [encodeArgument(headRefName)],
                decode: (stdout) =>
                  decodePositiveInt(
                    stdout,
                    repository,
                    "decode open pull request number",
                  ),
              }),
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
              callHelper({
                operation: "find-open-pull-request-number",
                repository,
                tokenName,
                describe: "find open pull request number",
                args: [encodeArgument(headRefName)],
                decode: (stdout) =>
                  decodeNullableInt(
                    stdout,
                    repository,
                    "decode open pull request number",
                  ),
              }),
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
              callHelper({
                operation: "create-draft-pull-request",
                repository,
                tokenName,
                describe: "create draft pull request",
                args: [
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
                decode: (stdout) =>
                  decodePositiveInt(
                    stdout,
                    repository,
                    "decode created draft pull request number",
                  ),
              }),
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
              callHelper({
                operation: "update-open-draft-pull-request-copy",
                repository,
                tokenName,
                describe: "update open draft pull request copy",
                args: [
                  encodeArgument(headRefName),
                  encodeArgument(
                    JSON.stringify({ title: input.title, body: input.body }),
                  ),
                ],
                decode: (stdout) =>
                  decodeNullableInt(
                    stdout,
                    repository,
                    "decode updated draft pull request number",
                  ),
              }),
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
              callHelper({
                operation: "count-open-non-draft-pull-requests",
                repository,
                tokenName,
                describe: "count open non-draft pull requests",
                decode: (stdout) =>
                  decodeNonNegativeInt(
                    stdout,
                    repository,
                    "decode open non-draft pull request count",
                  ),
              }),
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
              callHelper({
                operation: "get-pr-check-status",
                repository,
                tokenName,
                describe: "get pull request check status",
                args: [encodeArgument(headRefName)],
                decode: decodeJson(
                  SerializedPullRequestCheckStatus,
                  repository,
                  "decode pull request check status",
                ),
              }),
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
              return callHelper({
                operation: "get-pr-status-check-diagnostics",
                repository,
                tokenName,
                describe: "get PR Status Check diagnostics",
                args:
                  logDirectory === "" ? [checksArg] : [checksArg, logDirectory],
                decode: decodeJson(
                  SerializedPrStatusCheckDiagnostics,
                  repository,
                  "decode PR Status Check diagnostics",
                ),
              })
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
              callHelper({
                operation: "mark-pr-ready-for-review",
                repository,
                tokenName,
                describe: "mark pull request ready for review",
                args: [encodeArgument(headRefName)],
                decode: decodeVoid,
              }),
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
              callHelper({
                operation: "get-pr-lifecycle-status",
                repository,
                tokenName,
                describe: "get pull request lifecycle status",
                args: [encodeArgument(headRefName)],
                decode: decodeJson(
                  SerializedPullRequestLifecycleStatus,
                  repository,
                  "decode pull request lifecycle status",
                ),
              }),
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
                callHelper({
                  operation: "merge-pull-request",
                  repository,
                  tokenName,
                  describe: "merge pull request",
                  args: [encodeArgument(headRefName)],
                  decode: decodeJson(
                    SerializedMergePullRequestResult,
                    repository,
                    "decode merge pull request result",
                  ),
                }),
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
              callHelper({
                operation: "ensure-issue-completed-with-summary",
                repository,
                tokenName,
                describe: "ensure issue completed with summary",
                args: [
                  encodeArgument(String(issueNumber)),
                  encodeArgument(workItemId),
                  encodeArgument(summaryMarkdown),
                ],
                decode: decodeVoid,
              }),
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
              callHelper({
                operation: "close-open-pull-requests-for-branch",
                repository,
                tokenName,
                describe: "close open pull requests for branch",
                args: [encodeArgument(headRefName)],
                decode: decodeVoid,
              }),
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
                callHelper({
                  operation: "delete-branch",
                  repository,
                  tokenName,
                  describe: "delete branch",
                  args: [encodeArgument(branchName)],
                  decode: decodeVoid,
                }),
              (ambientService) =>
                ambientService.deleteBranch(repository, branchName),
            ),
        ),
      }
      return service
    }),
  )
