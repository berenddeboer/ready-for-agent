import { Deferred, Effect, Exit, Layer, Ref, Schema } from "effect"
import {
  type GitHubHelperOperation,
  type GitHubRepository,
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  type MergePullRequestResult,
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

type GitHubCountError = GitHubRepositoryUnavailableError | GitHubRequestError

type OpenPullRequestCountCacheEntry =
  | {
      readonly kind: "inflight"
      readonly deferred: Deferred.Deferred<number, GitHubCountError>
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

      const fetchOpenNonDraftPullRequestCount = (
        repository: GitHubRepository,
      ): Effect.Effect<number, GitHubCountError> =>
        Effect.gen(function* () {
          const tokenName = yield* ensureToken(repository)
          if (tokenName === null) {
            return yield* requestError(
              repository,
              "count open non-draft pull requests",
            )
          }
          const [forge, forgeHost, projectPath] =
            encodedRepositoryArguments(repository)
          const result = yield* runGitHubBin(
            tokenName,
            "count-open-non-draft-pull-requests",
            [forge, forgeHost, projectPath],
          )
          if (result.exitCode === 2) {
            return yield* repositoryUnavailable(repository)
          }
          if (result.exitCode !== 0) {
            return yield* requestError(
              repository,
              "count open non-draft pull requests",
              result.stderr || result.stdout,
            )
          }
          // Empty body on exit 0 must not become Number("") === 0 and then be
          // success-cached as a genuine open-PR count of zero.
          const trimmed = result.stdout.trim()
          if (trimmed === "") {
            return yield* requestError(
              repository,
              "decode open non-draft pull request count",
              "empty stdout",
            )
          }
          const count = Number(trimmed)
          if (!Number.isSafeInteger(count) || count < 0) {
            return yield* requestError(
              repository,
              "decode open non-draft pull request count",
              result.stdout,
            )
          }
          return count
        }).pipe(
          Effect.catchTag("KeymaxxerError", () =>
            Effect.fail(
              requestError(repository, "count open non-draft pull requests"),
            ),
          ),
        )

      /**
       * Process-wide single-flight + short success cache per Repository.
       * Concurrent callers share one Keymaxxer helper; failures are never
       * stored as a successful zero.
       */
      const countOpenNonDraftPullRequestsCoalesced = Effect.fn(
        "KeymaxxerGitHub.countOpenNonDraftPullRequests",
      )(function* (repository: GitHubRepository) {
        const key = openPullRequestCountCacheKey(repository)
        const candidate = yield* Deferred.make<number, GitHubCountError>()

        type Claim =
          | { readonly role: "owner" }
          | {
              readonly role: "join"
              readonly deferred: Deferred.Deferred<number, GitHubCountError>
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
        getAuthenticatedUserLogin: (repository) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "resolve authenticated GitHub user",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const result = yield* runGitHubBin(
              tokenName,
              "get-authenticated-user-login",
              [forge, forgeHost, projectPath],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "resolve authenticated GitHub user",
                result.stderr || result.stdout,
              )
            }
            const login = result.stdout.trim()
            if (login === "") {
              return yield* requestError(
                repository,
                "resolve authenticated GitHub user",
                "empty login",
              )
            }
            return login
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "resolve authenticated GitHub user"),
              ),
            ),
          ),
        getOpenPullRequestNumber: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "get open pull request number",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "get-open-pr-number",
              [forge, forgeHost, projectPath, head],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "get open pull request number",
                result.stderr || result.stdout,
              )
            }
            const number = Number(result.stdout.trim())
            if (!Number.isSafeInteger(number) || number <= 0) {
              return yield* requestError(
                repository,
                "decode open pull request number",
                result.stdout,
              )
            }
            return number
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "get open pull request number"),
              ),
            ),
          ),
        findOpenPullRequestNumber: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "find open pull request number",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "find-open-pr-number",
              [forge, forgeHost, projectPath, head],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "find open pull request number",
                result.stderr || result.stdout,
              )
            }
            const trimmed = result.stdout.trim()
            if (trimmed === "" || trimmed === "null") {
              return null
            }
            const number = Number(trimmed)
            if (!Number.isSafeInteger(number) || number <= 0) {
              return yield* requestError(
                repository,
                "decode open pull request number",
                result.stdout,
              )
            }
            return number
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "find open pull request number"),
              ),
            ),
          ),
        createDraftPullRequest: (repository, input) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "create draft pull request",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const payload = encodeArgument(
              JSON.stringify({
                headRefName: input.headRefName,
                title: input.title,
                body: input.body,
                ...(input.baseRefName === undefined
                  ? {}
                  : { baseRefName: input.baseRefName }),
              }),
            )
            const result = yield* runGitHubBin(
              tokenName,
              "create-draft-pull-request",
              [forge, forgeHost, projectPath, payload],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "create draft pull request",
                result.stderr || result.stdout,
              )
            }
            const number = Number(result.stdout.trim())
            if (!Number.isSafeInteger(number) || number <= 0) {
              return yield* requestError(
                repository,
                "decode created draft pull request number",
                result.stdout,
              )
            }
            return number
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "create draft pull request"),
              ),
            ),
          ),
        updateOpenDraftPullRequestCopy: (repository, headRefName, input) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "update open draft pull request copy",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const payload = encodeArgument(
              JSON.stringify({
                headRefName,
                title: input.title,
                body: input.body,
              }),
            )
            const result = yield* runGitHubBin(
              tokenName,
              "update-open-draft-pull-request-copy",
              [forge, forgeHost, projectPath, payload],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "update open draft pull request copy",
                result.stderr || result.stdout,
              )
            }
            const trimmed = result.stdout.trim()
            if (trimmed === "" || trimmed === "null") {
              return null
            }
            const number = Number(trimmed)
            if (!Number.isSafeInteger(number) || number <= 0) {
              return yield* requestError(
                repository,
                "decode updated draft pull request number",
                result.stdout,
              )
            }
            return number
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "update open draft pull request copy"),
              ),
            ),
          ),
        countOpenNonDraftPullRequests: countOpenNonDraftPullRequestsCoalesced,
        getPullRequestCheckStatus: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "get pull request check status",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "get-pr-check-status",
              [forge, forgeHost, projectPath, head],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "get pull request check status",
                result.stderr || result.stdout,
              )
            }
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(SerializedPullRequestCheckStatus),
            )(result.stdout).pipe(
              Effect.map((status) => ({
                ...status,
                headPushedAt: decodeOptionalInstant(status.headPushedAt),
                createdAt: decodeOptionalInstant(status.createdAt),
              })),
              Effect.mapError(() =>
                requestError(
                  repository,
                  "decode pull request check status",
                  result.stdout,
                ),
              ),
            )
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "get pull request check status"),
              ),
            ),
          ),
        getPrStatusCheckDiagnostics: (repository, checks, options = {}) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "get PR Status Check diagnostics",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
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
            const result = yield* runGitHubBin(
              tokenName,
              "get-pr-status-check-diagnostics",
              logDirectory === ""
                ? [forge, forgeHost, projectPath, checksArg]
                : [forge, forgeHost, projectPath, checksArg, logDirectory],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "get PR Status Check diagnostics",
                result.stderr || result.stdout,
              )
            }
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(SerializedPrStatusCheckDiagnostics),
            )(result.stdout).pipe(
              Effect.mapError(() =>
                requestError(
                  repository,
                  "decode PR Status Check diagnostics",
                  result.stdout,
                ),
              ),
            )
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "get PR Status Check diagnostics"),
              ),
            ),
          ),
        observeAutomatedReviewEvidence: (repository, headRefName, checks) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "observe automated review evidence",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const head = encodeArgument(headRefName)
            const checksArg = encodeArgument(
              JSON.stringify(
                checks.map((check) => ({
                  externalId: check.externalId,
                  name: check.name,
                })),
              ),
            )
            const result = yield* runGitHubBin(
              tokenName,
              "observe-automated-review-evidence",
              [forge, forgeHost, projectPath, head, checksArg],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "observe automated review evidence",
                result.stderr || result.stdout,
              )
            }
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                SerializedAutomatedReviewEvidenceObservation,
              ),
            )(result.stdout).pipe(
              Effect.mapError(() =>
                requestError(
                  repository,
                  "decode automated review evidence",
                  result.stdout,
                ),
              ),
            )
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "observe automated review evidence"),
              ),
            ),
          ),
        getPullRequestLifecycleStatus: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "get pull request lifecycle status",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "get-pr-lifecycle-status",
              [forge, forgeHost, projectPath, head],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "get pull request lifecycle status",
                result.stderr || result.stdout,
              )
            }
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(SerializedPullRequestLifecycleStatus),
            )(result.stdout).pipe(
              Effect.mapError(() =>
                requestError(
                  repository,
                  "decode pull request lifecycle status",
                  result.stdout,
                ),
              ),
            )
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "get pull request lifecycle status"),
              ),
            ),
          ),
        markPullRequestReadyForReview: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "mark pull request ready for review",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "mark-pr-ready-for-review",
              [forge, forgeHost, projectPath, head],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "mark pull request ready for review",
                result.stderr || result.stdout,
              )
            }
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "mark pull request ready for review"),
              ),
            ),
          ),
        mergePullRequest: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(repository, "merge pull request")
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "merge-pull-request",
              [forge, forgeHost, projectPath, head],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "merge pull request",
                result.stderr || result.stdout,
              )
            }
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(SerializedMergePullRequestResult),
            )(result.stdout).pipe(
              Effect.mapError(() =>
                requestError(
                  repository,
                  "decode merge pull request result",
                  result.stdout,
                ),
              ),
            ) as Effect.Effect<MergePullRequestResult, GitHubRequestError>
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(requestError(repository, "merge pull request")),
            ),
          ),
        rerunWorkflowRun: (repository, workflowRunId) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(repository, "rerun workflow run")
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const runId = encodeArgument(String(workflowRunId))
            const result = yield* runGitHubBin(
              tokenName,
              "rerun-workflow-run",
              [forge, forgeHost, projectPath, runId],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "rerun workflow run",
                result.stderr || result.stdout,
              )
            }
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(requestError(repository, "rerun workflow run")),
            ),
          ),
        ensureIssueCompletedWithSummary: (
          repository,
          issueNumber,
          workItemId,
          summaryMarkdown,
        ) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "complete Issue with summary",
              )
            }
            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const number = encodeArgument(String(issueNumber))
            const workItem = encodeArgument(workItemId)
            const summary = encodeArgument(summaryMarkdown)
            const result = yield* runGitHubBin(
              tokenName,
              "ensure-issue-completed-with-summary",
              [forge, forgeHost, projectPath, number, workItem, summary],
            )
            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "complete Issue with summary",
                result.stderr || result.stdout,
              )
            }
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "complete Issue with summary"),
              ),
            ),
          ),
        listReadyIssues: (repository) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "list Ready-labeled Issues",
              )
            }

            const [forge, forgeHost, projectPath] =
              encodedRepositoryArguments(repository)
            const result = yield* runGitHubBin(tokenName, "list-ready-issues", [
              forge,
              forgeHost,
              projectPath,
            ])

            if (result.exitCode === 2) {
              return yield* repositoryUnavailable(repository)
            }
            if (result.exitCode !== 0) {
              return yield* requestError(
                repository,
                "list Ready-labeled Issues",
                result.stderr || result.stdout,
              )
            }
            return yield* parseIssues(result.stdout, repository)
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(
                requestError(repository, "list Ready-labeled Issues"),
              ),
            ),
          ),
      }

      return service
    }),
  )
