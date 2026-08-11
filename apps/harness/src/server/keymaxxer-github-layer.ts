import {
  Cache,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect"
import {
  GITHUB_HELPER_AUTHENTICATION_EXIT_CODE,
  GITHUB_HELPER_THROTTLED_EXIT_CODE,
  GITHUB_HELPER_TLS_TRUST_EXIT_CODE,
  type GitHubHelperOperation,
  type GitHubOperationOptions,
  type GitHubRepository,
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceError,
  type GitHubServiceShape,
  GitHubThrottledError,
  GitHubTlsTrustError,
  formatGitHubHelperShellCommand,
  formatTlsTrustRemediation,
  parseGitHubHelperControl,
  resolveGitHubHelperChildSpawn,
} from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
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
import {
  GitHubOperationCoordinator,
  type GitHubOperationOrigin,
} from "./github-operation-coordinator.js"

/**
 * Successful Keymaxxer-backed open non-draft PR counts may be reused for this
 * long so concurrent tabs, reconnects, and closely spaced invalidations share
 * one helper invocation. Kept well below the UI poll interval (30s) so the
 * automatic visible-tab refresh still observes GitHub changes after expiry.
 */
export const OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS = 5_000

interface CountLookup {
  readonly fiber: Fiber.Fiber<number, GitHubServiceError>
  readonly start: CountLookupStart
  waiters: number
}

interface CountLookupStart {
  started: boolean
}

const openPullRequestCountCacheKey = (repository: GitHubRepository): string =>
  [
    repository.forge.toLowerCase(),
    repository.forgeHost.toLowerCase(),
    repository.projectPath.toLowerCase(),
  ].join("\0")

/** Cache namespace for one Repository's Keymaxxer credential path. */
const authenticatedUserCacheKey = (repository: GitHubRepository): string =>
  openPullRequestCountCacheKey(repository)

/** GitHub-only helper wire format (no GitLab counterpart). */
const SerializedAutomatedReviewEvidenceObservation = Schema.Union([
  Schema.TaggedStruct("none", {
    reason: Schema.Literals(["green-no-review-evidence"]),
  }),
  Schema.TaggedStruct("positive", {
    kind: Schema.Literals([
      "executed_reviewer_job",
      "review_comment",
      "pull_request_review",
    ]),
    detail: Schema.String,
  }),
  Schema.TaggedStruct("ambiguous", {
    reason: Schema.String,
  }),
])

/**
 * Helper output is an untrusted credential boundary. Do not copy it into
 * request errors: those errors can be returned via GraphQL and logged by the
 * caller. The optional detail parameter preserves the shared parser callback
 * shape while deliberately discarding any helper-supplied text.
 */
const requestError = (
  repository: GitHubRepository,
  operation: string,
  _detail?: string,
) => makeRequestError(GitHubRequestError)(repository, operation)

const authenticationError = (
  repository: GitHubRepository,
  operation: string,
  detail?: string,
) =>
  new GitHubRequestError({
    message: requestError(repository, operation, detail).message,
    statusCode: 401,
  })

const repositoryUnavailable = (repository: GitHubRepository) =>
  new GitHubRepositoryUnavailableError(repository)

const parseIssues = parseSerializedIssues(requestError)

/** Decode a positive integer from helper stdout (trimmed). */
const decodePositiveInt = (
  stdout: string,
  repository: GitHubRepository,
  describe: string,
): Effect.Effect<number, GitHubRequestError> => {
  const number = Number(stdout.trim())
  if (!Number.isSafeInteger(number) || number <= 0) {
    return Effect.fail(requestError(repository, describe))
  }
  return Effect.succeed(number)
}

/**
 * Decode a non-negative integer from helper stdout.
 * Empty body on exit 0 must not become `Number("") === 0`.
 */
const decodeNonNegativeInt = (
  stdout: string,
  repository: GitHubRepository,
  describe: string,
): Effect.Effect<number, GitHubRequestError> => {
  const trimmed = stdout.trim()
  if (trimmed === "") {
    return Effect.fail(requestError(repository, describe, "empty stdout"))
  }
  const count = Number(trimmed)
  if (!Number.isSafeInteger(count) || count < 0) {
    return Effect.fail(requestError(repository, describe))
  }
  return Effect.succeed(count)
}

/** Decode a positive integer, or null when stdout is empty / `"null"`. */
const decodeNullableInt = (
  stdout: string,
  repository: GitHubRepository,
  describe: string,
): Effect.Effect<number | null, GitHubRequestError> => {
  const trimmed = stdout.trim()
  if (trimmed === "" || trimmed === "null") {
    return Effect.succeed(null)
  }
  const number = Number(trimmed)
  if (!Number.isSafeInteger(number) || number <= 0) {
    return Effect.fail(requestError(repository, describe))
  }
  return Effect.succeed(number)
}

const decodeVoid = (_stdout: string): Effect.Effect<void, never> => Effect.void

const decodeNonEmptyTrimmed = (
  stdout: string,
  repository: GitHubRepository,
  describe: string,
  emptyDetail: string,
): Effect.Effect<string, GitHubRequestError> => {
  const value = stdout.trim()
  if (value === "") {
    return Effect.fail(requestError(repository, describe, emptyDetail))
  }
  return Effect.succeed(value)
}

const decodeJson =
  <A, I>(
    schema: Schema.Codec<A, I>,
    repository: GitHubRepository,
    describe: string,
  ) =>
  (stdout: string): Effect.Effect<A, GitHubRequestError> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout).pipe(
      Effect.mapError(() => requestError(repository, describe)),
    )

export const keymaxxerGitHubLayer = (options: {
  readonly workspaceRoot: string
  /**
   * Override the successful-count freshness window (tests and experiments).
   * Defaults to {@link OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS}.
   * Expiry is driven by the Effect `Clock` (use `TestClock` in tests).
   */
  readonly openPullRequestCountFreshnessMs?: number
}): Layer.Layer<
  GitHubService,
  never,
  KeymaxxerService | GitHubOperationCoordinator
> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const keymaxxer = yield* KeymaxxerService
      const coordinator = yield* GitHubOperationCoordinator
      const layerScope = yield* Effect.scope
      const countFreshnessMs =
        options.openPullRequestCountFreshnessMs ??
        OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS
      const ensureToken = Effect.fn("KeymaxxerGitHub.ensureToken")(
        (repository: GitHubRepository) =>
          keymaxxer.findSecret({
            provider: "github",
            account: repository.projectPath,
          }),
      )
      const runGitHubCommand = Effect.fn("KeymaxxerGitHub.runCommand")(
        (tokenName: string, command: string) =>
          keymaxxer.runWithSecrets({
            command: `GITHUB_TOKEN="$${tokenName}" ${command}`,
            cwd: options.workspaceRoot,
            secrets: [tokenName],
            timeoutMs: 60_000,
          }),
      )
      const runGitHubBin = Effect.fn("KeymaxxerGitHub.runHelper")(
        (
          tokenName: string,
          operation: GitHubHelperOperation,
          args: readonly string[],
        ) =>
          runGitHubCommand(
            tokenName,
            formatGitHubHelperShellCommand(
              resolveGitHubHelperChildSpawn({ operation, args }),
            ),
          ),
      )

      let invalidateAuthenticatedUser = (
        _repository: GitHubRepository,
      ): Effect.Effect<void> => Effect.void
      let observeCredential = (
        _repository: GitHubRepository,
        _tokenName: string | null,
      ): Effect.Effect<void> => Effect.void

      /**
       * Shared Keymaxxer helper invocation: token lookup, repository arg
       * encoding, exit-code mapping, stdout decode, and KeymaxxerError →
       * requestError. Each service method supplies only operation, args, and
       * a decoder.
       */
      const callHelper = <A>(input: {
        readonly operation: GitHubHelperOperation
        readonly repository: GitHubRepository
        readonly describe: string
        readonly args?: readonly string[]
        readonly origin?: GitHubOperationOrigin
        readonly onStart?: () => void
        readonly decode: (
          stdout: string,
        ) => Effect.Effect<A, GitHubRequestError>
      }): Effect.Effect<A, GitHubServiceError> =>
        coordinator
          .execute({
            origin: input.origin ?? "lifecycle",
            operation: Effect.gen(function* () {
              input.onStart?.()
              const tokenName = yield* ensureToken(input.repository)
              yield* observeCredential(input.repository, tokenName)
              if (tokenName === null) {
                return yield* requestError(input.repository, input.describe)
              }
              const [forge, forgeHost, projectPath] =
                encodedRepositoryArguments(input.repository)
              const result = yield* runGitHubBin(tokenName, input.operation, [
                forge,
                forgeHost,
                projectPath,
                ...(input.args ?? []),
              ])
              if (result.exitCode === 2) {
                return yield* repositoryUnavailable(input.repository)
              }
              if (result.exitCode === GITHUB_HELPER_THROTTLED_EXIT_CODE) {
                const control = parseGitHubHelperControl(result.stderr)
                if (control?.kind !== "github-throttled") {
                  return yield* requestError(input.repository, input.describe)
                }
                return yield* coordinator.reportThrottle(
                  new GitHubThrottledError({
                    retryAt: control.retryAt,
                    usedFallback: control.usedFallback,
                  }),
                )
              }
              if (result.exitCode === GITHUB_HELPER_AUTHENTICATION_EXIT_CODE) {
                return yield* authenticationError(
                  input.repository,
                  input.describe,
                )
              }
              if (result.exitCode === GITHUB_HELPER_TLS_TRUST_EXIT_CODE) {
                const control = parseGitHubHelperControl(result.stderr)
                if (control?.kind !== "github-tls-trust") {
                  return yield* requestError(input.repository, input.describe)
                }
                const operationMessage = requestError(
                  input.repository,
                  input.describe,
                ).message
                return yield* new GitHubTlsTrustError({
                  message: formatTlsTrustRemediation({
                    host: control.host,
                    code: control.code,
                    operationMessage,
                  }),
                  host: control.host,
                  code: control.code,
                })
              }
              if (result.exitCode !== 0) {
                return yield* requestError(input.repository, input.describe)
              }
              const control = parseGitHubHelperControl(result.stderr)
              if (control?.kind !== "success") {
                return yield* requestError(input.repository, input.describe)
              }
              const value = yield* input.decode(result.stdout)
              if (control.throttle !== null) {
                coordinator.reportThrottle(
                  new GitHubThrottledError({
                    retryAt: control.throttle.retryAt,
                    usedFallback: control.throttle.usedFallback,
                  }),
                )
              }
              return value
            }).pipe(
              Effect.catchTag("KeymaxxerError", () =>
                Effect.fail(requestError(input.repository, input.describe)),
              ),
            ),
          })
          .pipe(
            Effect.tapError((error) =>
              error._tag === "GitHubRequestError" && error.statusCode === 401
                ? invalidateAuthenticatedUser(input.repository)
                : Effect.void,
            ),
          )

      const fetchOpenNonDraftPullRequestCount = (
        repository: GitHubRepository,
        onStart?: () => void,
      ): Effect.Effect<number, GitHubServiceError> =>
        callHelper({
          operation: "count-open-non-draft-pull-requests",
          repository,
          describe: "count open non-draft pull requests",
          origin: "background",
          ...(onStart === undefined ? {} : { onStart }),
          decode: (stdout) =>
            decodeNonNegativeInt(
              stdout,
              repository,
              "decode open non-draft pull request count",
            ),
        })

      /**
       * Process-wide single-flight + short success cache per Repository.
       * Concurrent callers share one Keymaxxer helper; failures expire
       * immediately (TTL zero, not reused) so they cannot surface as a
       * successful zero. Success TTL is driven by the Effect Clock
       * (TestClock in tests). Lookup uses the original repository object
       * (not a lowercased key reconstruction) for secret/helper casing.
       */
      const repositoriesByCountCacheKey = new Map<string, GitHubRepository>()
      const countLookupStarts = new Map<string, CountLookupStart>()
      const countLookups = new Map<string, CountLookup>()
      const removeCountLookup = (key: string, lookup: CountLookup): void => {
        if (countLookups.get(key) !== lookup) return
        countLookups.delete(key)
        if (countLookupStarts.get(key) === lookup.start) {
          countLookupStarts.delete(key)
        }
      }
      const openPullRequestCountCache = yield* Cache.makeWith(
        (key: string) => {
          const start = countLookupStarts.get(key)
          const onStart =
            start === undefined
              ? undefined
              : () => {
                  start.started = true
                  if (countLookupStarts.get(key) === start) {
                    countLookupStarts.delete(key)
                  }
                }
          const repository = repositoriesByCountCacheKey.get(key)
          if (repository === undefined) {
            // Should not happen: callers register before Cache.get.
            const [forge = "", forgeHost = "", projectPath = ""] =
              key.split("\0")
            return fetchOpenNonDraftPullRequestCount(
              { forge, forgeHost, projectPath },
              onStart,
            )
          }
          return fetchOpenNonDraftPullRequestCount(repository, onStart)
        },
        {
          capacity: 256,
          timeToLive: (exit) =>
            Exit.isSuccess(exit)
              ? Duration.millis(countFreshnessMs)
              : Duration.zero,
        },
      )

      const countOpenNonDraftPullRequestsCoalesced = Effect.fn(
        "KeymaxxerGitHub.countOpenNonDraftPullRequests",
      )(function* (repository: GitHubRepository) {
        const key = openPullRequestCountCacheKey(repository)
        repositoriesByCountCacheKey.set(key, repository)
        const cached = yield* Cache.getSuccess(openPullRequestCountCache, key)
        if (Option.isSome(cached)) return cached.value

        const makeLookup = Effect.fn("KeymaxxerGitHub.makeCountLookup")(
          function* () {
            const start: CountLookupStart = { started: false }
            countLookupStarts.set(key, start)
            const fiber = yield* Cache.get(openPullRequestCountCache, key).pipe(
              Effect.forkIn(layerScope),
            )
            const lookup: CountLookup = {
              fiber,
              start,
              waiters: 1,
            }
            countLookups.set(key, lookup)
            fiber.addObserver(() => removeCountLookup(key, lookup))
            return lookup
          },
        )

        const acquireLookup = Effect.suspend(() => {
          const existing = countLookups.get(key)
          if (existing === undefined) return makeLookup()
          existing.waiters += 1
          return Effect.succeed(existing)
        })

        return yield* Effect.acquireUseRelease(
          acquireLookup,
          (lookup) => Fiber.join(lookup.fiber),
          (lookup, exit) =>
            Effect.suspend(() => {
              lookup.waiters -= 1
              if (lookup.waiters !== 0) {
                return Effect.void
              }
              if (lookup.start.started && Exit.hasInterrupts(exit)) {
                return Effect.void
              }
              removeCountLookup(key, lookup)
              if (lookup.start.started) return Effect.void
              return Cache.invalidate(openPullRequestCountCache, key).pipe(
                Effect.andThen(Fiber.interrupt(lookup.fiber)),
              )
            }),
        )
      })

      const authenticatedUserLookupsByCacheKey = new Map<
        string,
        {
          readonly repository: GitHubRepository
          readonly origin: GitHubOperationOrigin
        }
      >()
      const authenticatedUserCredentialNamesByRepository = new Map<
        string,
        string
      >()
      const authenticatedUserCache = yield* Cache.makeWith(
        (key: string) => {
          const lookup = authenticatedUserLookupsByCacheKey.get(key)
          if (lookup === undefined) {
            return Effect.fail(
              requestError(
                { forge: "github", forgeHost: "", projectPath: "" },
                "resolve authenticated GitHub user",
                "missing identity cache key",
              ),
            )
          }
          return callHelper({
            operation: "get-authenticated-user-login",
            repository: lookup.repository,
            describe: "resolve authenticated GitHub user",
            origin: lookup.origin,
            decode: (stdout) =>
              decodeNonEmptyTrimmed(
                stdout,
                lookup.repository,
                "resolve authenticated GitHub user",
                "empty login",
              ),
          })
        },
        {
          capacity: 256,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
        },
      )

      invalidateAuthenticatedUser = (repository) => {
        const key = authenticatedUserCacheKey(repository)
        authenticatedUserLookupsByCacheKey.delete(key)
        return Cache.invalidate(authenticatedUserCache, key)
      }

      observeCredential = (repository, tokenName) => {
        const repositoryKey = openPullRequestCountCacheKey(repository)
        const previousTokenName =
          authenticatedUserCredentialNamesByRepository.get(repositoryKey)
        if (tokenName === null) {
          if (previousTokenName === undefined) return Effect.void
          authenticatedUserCredentialNamesByRepository.delete(repositoryKey)
          return invalidateAuthenticatedUser(repository)
        }
        if (previousTokenName === tokenName) return Effect.void
        authenticatedUserCredentialNamesByRepository.set(
          repositoryKey,
          tokenName,
        )
        return previousTokenName === undefined
          ? Effect.void
          : invalidateAuthenticatedUser(repository)
      }

      const getAuthenticatedUserLogin = Effect.fn(
        "KeymaxxerGitHub.getAuthenticatedUserLogin",
      )(function* (
        repository: GitHubRepository,
        operationOptions?: GitHubOperationOptions,
      ) {
        const key = authenticatedUserCacheKey(repository)
        authenticatedUserLookupsByCacheKey.set(key, {
          repository,
          origin: operationOptions?.origin ?? "polling",
        })
        const cached = yield* Cache.getSuccess(authenticatedUserCache, key)
        if (Option.isSome(cached)) return cached.value

        // Cache owns the lookup for the application scope, so a canceled
        // caller cannot tear down a concurrent reconciliation's identity work.
        const lookup = yield* Cache.get(authenticatedUserCache, key).pipe(
          Effect.forkIn(layerScope),
        )
        return yield* Fiber.join(lookup)
      })

      const service: GitHubServiceShape = {
        getAuthenticatedUserLogin,
        getOpenPullRequestNumber: Effect.fn(
          "KeymaxxerGitHub.getOpenPullRequestNumber",
        )((repository, headRefName) =>
          callHelper({
            operation: "get-open-pr-number",
            repository,
            describe: "get open pull request number",
            args: [encodeArgument(headRefName)],
            decode: (stdout) =>
              decodePositiveInt(
                stdout,
                repository,
                "decode open pull request number",
              ),
          }),
        ),
        findOpenPullRequestNumber: Effect.fn(
          "KeymaxxerGitHub.findOpenPullRequestNumber",
        )((repository, headRefName) =>
          callHelper({
            operation: "find-open-pr-number",
            repository,
            describe: "find open pull request number",
            args: [encodeArgument(headRefName)],
            decode: (stdout) =>
              decodeNullableInt(
                stdout,
                repository,
                "decode open pull request number",
              ),
          }),
        ),
        closeOpenPullRequestsAndDeleteBranch: Effect.fn(
          "KeymaxxerGitHub.closeOpenPullRequestsAndDeleteBranch",
        )((repository, headRefName) =>
          callHelper({
            operation: "close-open-pull-requests-and-delete-branch",
            repository,
            describe: "close open pull requests and delete remote branch",
            args: [encodeArgument(headRefName)],
            origin: "operator",
            decode: decodeVoid,
          }),
        ),
        createDraftPullRequest: Effect.fn(
          "KeymaxxerGitHub.createDraftPullRequest",
        )((repository, input) =>
          callHelper({
            operation: "create-draft-pull-request",
            repository,
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
        ),
        updateOpenDraftPullRequestCopy: Effect.fn(
          "KeymaxxerGitHub.updateOpenDraftPullRequestCopy",
        )((repository, headRefName, input) =>
          callHelper({
            operation: "update-open-draft-pull-request-copy",
            repository,
            describe: "update open draft pull request copy",
            args: [
              encodeArgument(
                JSON.stringify({
                  headRefName,
                  title: input.title,
                  body: input.body,
                }),
              ),
            ],
            decode: (stdout) =>
              decodeNullableInt(
                stdout,
                repository,
                "decode updated draft pull request number",
              ),
          }),
        ),
        countOpenNonDraftPullRequests: countOpenNonDraftPullRequestsCoalesced,
        getPullRequestCheckStatus: Effect.fn(
          "KeymaxxerGitHub.getPullRequestCheckStatus",
        )((repository, headRefName) =>
          callHelper({
            operation: "get-pr-check-status",
            repository,
            describe: "get pull request check status",
            args: [encodeArgument(headRefName)],
            decode: decodeJson(
              SerializedPullRequestCheckStatus,
              repository,
              "decode pull request check status",
            ),
          }),
        ),
        getPrStatusCheckDiagnostics: Effect.fn(
          "KeymaxxerGitHub.getPrStatusCheckDiagnostics",
        )((repository, checks, options = {}) => {
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
            describe: "get PR Status Check diagnostics",
            args: logDirectory === "" ? [checksArg] : [checksArg, logDirectory],
            decode: decodeJson(
              SerializedPrStatusCheckDiagnostics,
              repository,
              "decode PR Status Check diagnostics",
            ),
          })
        }),
        observeAutomatedReviewEvidence: Effect.fn(
          "KeymaxxerGitHub.observeAutomatedReviewEvidence",
        )((repository, headRefName, checks) =>
          callHelper({
            operation: "observe-automated-review-evidence",
            repository,
            describe: "observe automated review evidence",
            args: [
              encodeArgument(headRefName),
              encodeArgument(
                JSON.stringify(
                  checks.map((check) => ({
                    externalId: check.externalId,
                    name: check.name,
                  })),
                ),
              ),
            ],
            decode: decodeJson(
              SerializedAutomatedReviewEvidenceObservation,
              repository,
              "decode automated review evidence",
            ),
          }),
        ),
        getPullRequestLifecycleStatus: Effect.fn(
          "KeymaxxerGitHub.getPullRequestLifecycleStatus",
        )((repository, headRefName) =>
          callHelper({
            operation: "get-pr-lifecycle-status",
            repository,
            describe: "get pull request lifecycle status",
            args: [encodeArgument(headRefName)],
            decode: decodeJson(
              SerializedPullRequestLifecycleStatus,
              repository,
              "decode pull request lifecycle status",
            ),
          }),
        ),
        markPullRequestReadyForReview: Effect.fn(
          "KeymaxxerGitHub.markPullRequestReadyForReview",
        )((repository, headRefName) =>
          callHelper({
            operation: "mark-pr-ready-for-review",
            repository,
            describe: "mark pull request ready for review",
            args: [encodeArgument(headRefName)],
            decode: decodeVoid,
          }),
        ),
        mergePullRequest: Effect.fn("KeymaxxerGitHub.mergePullRequest")(
          (repository, headRefName) =>
            callHelper({
              operation: "merge-pull-request",
              repository,
              describe: "merge pull request",
              args: [encodeArgument(headRefName)],
              decode: decodeJson(
                SerializedMergePullRequestResult,
                repository,
                "decode merge pull request result",
              ),
            }),
        ),
        rerunWorkflowRun: Effect.fn("KeymaxxerGitHub.rerunWorkflowRun")(
          (repository, workflowRunId) =>
            callHelper({
              operation: "rerun-workflow-run",
              repository,
              describe: "rerun workflow run",
              args: [encodeArgument(String(workflowRunId))],
              decode: decodeVoid,
            }),
        ),
        ensureIssueCompletedWithSummary: Effect.fn(
          "KeymaxxerGitHub.ensureIssueCompletedWithSummary",
        )((repository, issueNumber, workItemId, summaryMarkdown) =>
          callHelper({
            operation: "ensure-issue-completed-with-summary",
            repository,
            describe: "complete Issue with summary",
            args: [
              encodeArgument(String(issueNumber)),
              encodeArgument(workItemId),
              encodeArgument(summaryMarkdown),
            ],
            decode: decodeVoid,
          }),
        ),
        listReadyIssues: Effect.fn("KeymaxxerGitHub.listReadyIssues")(
          (repository, operationOptions?: GitHubOperationOptions) =>
            callHelper({
              operation: "list-ready-issues",
              repository,
              describe: "list Ready-labeled Issues",
              origin: operationOptions?.origin ?? "polling",
              decode: (stdout) => parseIssues(stdout, repository),
            }),
        ),
      }

      return service
    }),
  )
