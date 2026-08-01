import { Deferred, Effect, Exit, Layer, Ref, Schema } from "effect"
import {
  type GitHubHelperOperation,
  type GitHubRepository,
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  type ReadyLabeledIssue,
  formatGitHubHelperShellCommand,
  resolveGitHubHelperChildSpawn,
  sanitizeUserFacingText,
} from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"

/**
 * Successful Keymaxxer-backed open non-draft PR counts may be reused for this
 * long so concurrent tabs, reconnects, and closely spaced invalidations share
 * one helper invocation. Kept well below the UI poll interval (30s) so the
 * automatic visible-tab refresh still observes GitHub changes after expiry.
 */
export const OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS = 5_000

type GitHubServiceError = GitHubRepositoryUnavailableError | GitHubRequestError

type OpenPullRequestCountCacheEntry =
  | {
      readonly kind: "inflight"
      readonly deferred: Deferred.Deferred<number, GitHubServiceError>
    }
  | {
      readonly kind: "success"
      readonly count: number
      readonly fetchedAtMs: number
    }

const openPullRequestCountCacheKey = (repository: GitHubRepository): string =>
  [
    repository.forge.toLowerCase(),
    repository.forgeHost.toLowerCase(),
    repository.projectPath.toLowerCase(),
  ].join("\0")

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

const requestError = (
  repository: GitHubRepository,
  operation: string,
  detail?: string,
) => {
  const cleaned =
    detail === undefined || detail.trim() === ""
      ? ""
      : sanitizeUserFacingText(detail, 300)
  return new GitHubRequestError({
    message:
      cleaned === ""
        ? `Failed to ${operation} for ${repository.projectPath}`
        : `Failed to ${operation} for ${repository.projectPath}: ${cleaned}`,
  })
}

const encodeArgument = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const encodedRepositoryArguments = (repository: GitHubRepository) => {
  return [
    encodeArgument(repository.forge),
    encodeArgument(repository.forgeHost),
    encodeArgument(repository.projectPath),
  ] as const
}

const repositoryUnavailable = (repository: GitHubRepository) =>
  new GitHubRepositoryUnavailableError(repository)

const parseIssues = (
  stdout: string,
  repository: GitHubRepository,
): Effect.Effect<readonly ReadyLabeledIssue[], GitHubRequestError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(SerializedIssues))(
    stdout,
  ).pipe(
    Effect.mapError(() =>
      requestError(repository, "list Ready-labeled Issues"),
    ),
  )

/** Decode a positive integer from helper stdout (trimmed). */
const decodePositiveInt = (
  stdout: string,
  repository: GitHubRepository,
  describe: string,
): Effect.Effect<number, GitHubRequestError> => {
  const number = Number(stdout.trim())
  if (!Number.isSafeInteger(number) || number <= 0) {
    return Effect.fail(requestError(repository, describe, stdout))
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
    return Effect.fail(requestError(repository, describe, stdout))
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
    return Effect.fail(requestError(repository, describe, stdout))
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
      Effect.mapError(() => requestError(repository, describe, stdout)),
    )

export const keymaxxerGitHubLayer = (options: {
  readonly workspaceRoot: string
  /**
   * Override the successful-count freshness window (tests and experiments).
   * Defaults to {@link OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS}.
   */
  readonly openPullRequestCountFreshnessMs?: number
  /** Injectable clock for freshness tests. Defaults to `Date.now`. */
  readonly nowMs?: () => number
}): Layer.Layer<GitHubService, never, KeymaxxerService> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const keymaxxer = yield* KeymaxxerService
      const layerScope = yield* Effect.scope
      const countFreshnessMs =
        options.openPullRequestCountFreshnessMs ??
        OPEN_PULL_REQUEST_COUNT_FRESHNESS_MS
      const nowMs = options.nowMs ?? Date.now
      const openPullRequestCountCache = yield* Ref.make(
        new Map<string, OpenPullRequestCountCacheEntry>(),
      )
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
        readonly decode: (
          stdout: string,
        ) => Effect.Effect<A, GitHubRequestError>
      }): Effect.Effect<A, GitHubServiceError> =>
        Effect.gen(function* () {
          const tokenName = yield* ensureToken(input.repository)
          if (tokenName === null) {
            return yield* requestError(input.repository, input.describe)
          }
          const [forge, forgeHost, projectPath] = encodedRepositoryArguments(
            input.repository,
          )
          const result = yield* runGitHubBin(tokenName, input.operation, [
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

      const fetchOpenNonDraftPullRequestCount = (
        repository: GitHubRepository,
      ): Effect.Effect<number, GitHubServiceError> =>
        callHelper({
          operation: "count-open-non-draft-pull-requests",
          repository,
          describe: "count open non-draft pull requests",
          decode: (stdout) =>
            decodeNonNegativeInt(
              stdout,
              repository,
              "decode open non-draft pull request count",
            ),
        })

      /**
       * Process-wide single-flight + short success cache per Repository.
       * Concurrent callers share one Keymaxxer helper; failures are never
       * stored as a successful zero.
       */
      const countOpenNonDraftPullRequestsCoalesced = Effect.fn(
        "KeymaxxerGitHub.countOpenNonDraftPullRequests",
      )(function* (repository: GitHubRepository) {
        const key = openPullRequestCountCacheKey(repository)
        const candidate = yield* Deferred.make<number, GitHubServiceError>()

        type Claim =
          | { readonly role: "owner" }
          | {
              readonly role: "join"
              readonly deferred: Deferred.Deferred<number, GitHubServiceError>
            }
          | { readonly role: "cached"; readonly count: number }

        const claim = yield* Ref.modify(
          openPullRequestCountCache,
          (cache): [Claim, Map<string, OpenPullRequestCountCacheEntry>] => {
            const current = cache.get(key)
            const observedAt = nowMs()
            if (
              current?.kind === "success" &&
              observedAt - current.fetchedAtMs < countFreshnessMs
            ) {
              return [{ role: "cached", count: current.count }, cache]
            }
            if (current?.kind === "inflight") {
              return [{ role: "join", deferred: current.deferred }, cache]
            }
            const next = new Map(cache)
            next.set(key, { kind: "inflight", deferred: candidate })
            return [{ role: "owner" }, next]
          },
        )

        if (claim.role === "cached") {
          return claim.count
        }
        if (claim.role === "join") {
          return yield* Deferred.await(claim.deferred)
        }

        // Use Exit (not Effect.result) so interrupt/defect also settles the
        // shared Deferred and clears inflight; otherwise joiners could hang.
        // Settle is uninterruptible so layer teardown cannot leave joiners
        // waiting after the fetch Exit is already known.
        yield* fetchOpenNonDraftPullRequestCount(repository).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Ref.update(openPullRequestCountCache, (cache) => {
                  const next = new Map(cache)
                  const current = next.get(key)
                  if (
                    current?.kind !== "inflight" ||
                    current.deferred !== candidate
                  ) {
                    return cache
                  }
                  if (Exit.isSuccess(exit)) {
                    next.set(key, {
                      kind: "success",
                      count: exit.value,
                      fetchedAtMs: nowMs(),
                    })
                  } else {
                    // Failures / interrupt must not leave a permanent inflight
                    // entry or be stored as a successful zero.
                    next.delete(key)
                  }
                  return next
                })
                yield* Deferred.done(candidate, exit)
              }),
            ),
          ),
          Effect.forkIn(layerScope, { startImmediately: true }),
        )

        return yield* Deferred.await(candidate)
      })

      const service: GitHubServiceShape = {
        getAuthenticatedUserLogin: Effect.fn(
          "KeymaxxerGitHub.getAuthenticatedUserLogin",
        )((repository) =>
          callHelper({
            operation: "get-authenticated-user-login",
            repository,
            describe: "resolve authenticated GitHub user",
            decode: (stdout) =>
              decodeNonEmptyTrimmed(
                stdout,
                repository,
                "resolve authenticated GitHub user",
                "empty login",
              ),
          }),
        ),
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
            decode: (stdout) =>
              decodeJson(
                SerializedPullRequestCheckStatus,
                repository,
                "decode pull request check status",
              )(stdout).pipe(
                Effect.map((status) => ({
                  ...status,
                  headPushedAt: decodeOptionalInstant(status.headPushedAt),
                  createdAt: decodeOptionalInstant(status.createdAt),
                })),
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
          (repository) =>
            callHelper({
              operation: "list-ready-issues",
              repository,
              describe: "list Ready-labeled Issues",
              decode: (stdout) => parseIssues(stdout, repository),
            }),
        ),
      }

      return service
    }),
  )
