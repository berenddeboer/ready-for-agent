import { Effect, Layer, Schema } from "effect"
import {
  type GitHubHelperOperation,
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
  source: Schema.Literals(["actions-job", "status", "unknown"]),
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
} as const

const SerializedPullRequestCheckStatus = Schema.Union([
  Schema.TaggedStruct("pending", {
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

const decodeHeadPushedAt = (value: string | null): Date | null => {
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
  repository: { owner: string; name: string },
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
        ? `Failed to ${operation} for ${repository.owner}/${repository.name}`
        : `Failed to ${operation} for ${repository.owner}/${repository.name}: ${cleaned}`,
  })
}

const encodeArgument = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const parseIssues = (
  stdout: string,
  repository: { owner: string; name: string },
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
}): Layer.Layer<GitHubService, never, KeymaxxerService> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const keymaxxer = yield* KeymaxxerService
      const ensureToken = Effect.fn("KeymaxxerGitHub.ensureToken")(
        (repository: { owner: string; name: string }) =>
          keymaxxer.findSecret({
            provider: "github",
            account: `${repository.owner}/${repository.name}`,
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
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const result = yield* runGitHubBin(
              tokenName,
              "get-authenticated-user-login",
              [owner, name],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "get-open-pr-number",
              [owner, name, head],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
        getPullRequestCheckStatus: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "get pull request check status",
              )
            }
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "get-pr-check-status",
              [owner, name, head],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
                headPushedAt: decodeHeadPushedAt(status.headPushedAt),
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
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
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
                ? [owner, name, checksArg]
                : [owner, name, checksArg, logDirectory],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
        getPullRequestLifecycleStatus: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(
                repository,
                "get pull request lifecycle status",
              )
            }
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "get-pr-lifecycle-status",
              [owner, name, head],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "mark-pr-ready-for-review",
              [owner, name, head],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const head = encodeArgument(headRefName)
            const result = yield* runGitHubBin(
              tokenName,
              "merge-pull-request",
              [owner, name, head],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const number = encodeArgument(String(issueNumber))
            const workItem = encodeArgument(workItemId)
            const summary = encodeArgument(summaryMarkdown)
            const result = yield* runGitHubBin(
              tokenName,
              "ensure-issue-completed-with-summary",
              [owner, name, number, workItem, summary],
            )
            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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

            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const result = yield* runGitHubBin(tokenName, "list-ready-issues", [
              owner,
              name,
            ])

            if (result.exitCode === 2) {
              return yield* new GitHubRepositoryUnavailableError(repository)
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
