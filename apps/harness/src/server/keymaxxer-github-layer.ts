import { Effect, Layer, Schema } from "effect"
import {
  type GitHubHelperOperation,
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

const SerializedIssue = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  hierarchySupported: Schema.Boolean,
  hasChildren: Schema.Boolean,
  parentPosition: Schema.NullOr(Schema.Finite),
  parent: Schema.NullOr(
    Schema.Struct({
      number: Schema.Finite,
      url: Schema.String,
      state: Schema.Literals(["OPEN", "CLOSED"]),
      isReadyLabeled: Schema.Boolean,
    }),
  ),
  blockedBy: Schema.Array(
    Schema.Struct({
      number: Schema.Finite,
      url: Schema.String,
    }),
  ),
  closingPullRequests: Schema.Array(
    Schema.Struct({
      number: Schema.Finite,
      repository: Schema.String,
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
  Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: () => requestError(repository, "list Ready-labeled Issues"),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(SerializedIssues)(value).pipe(
        Effect.mapError(() =>
          requestError(repository, "list Ready-labeled Issues"),
        ),
      ),
    ),
    Effect.flatMap((issues) =>
      Effect.try({
        try: () =>
          issues.map((issue) => {
            if (!Number.isSafeInteger(issue.number) || issue.number <= 0) {
              throw new Error("Invalid Issue number")
            }
            if (issue.title.trim() === "") {
              throw new Error("Invalid Issue title")
            }
            const createdAt = new Date(issue.createdAt)
            if (Number.isNaN(createdAt.getTime())) {
              throw new Error("Invalid Issue creation time")
            }
            new URL(issue.url)
            if (issue.parent !== null) {
              if (
                !Number.isSafeInteger(issue.parent.number) ||
                issue.parent.number <= 0
              ) {
                throw new Error("Invalid parent Issue number")
              }
              new URL(issue.parent.url)
            }
            if (
              issue.parentPosition !== null &&
              (!Number.isSafeInteger(issue.parentPosition) ||
                issue.parentPosition < 0)
            ) {
              throw new Error("Invalid parent position")
            }
            for (const dependency of issue.blockedBy) {
              if (
                !Number.isSafeInteger(dependency.number) ||
                dependency.number <= 0
              ) {
                throw new Error("Invalid dependency Issue number")
              }
              new URL(dependency.url)
            }
            for (const pullRequest of issue.closingPullRequests) {
              if (
                !Number.isSafeInteger(pullRequest.number) ||
                pullRequest.number <= 0 ||
                pullRequest.repository.trim() === ""
              ) {
                throw new Error("Invalid closing pull request identity")
              }
            }
            return { ...issue, createdAt }
          }),
        catch: () => requestError(repository, "list Ready-labeled Issues"),
      }),
    ),
  )

export const keymaxxerGitHubLayer = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<GitHubService, never, KeymaxxerService> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const keymaxxer = yield* KeymaxxerService
      const ensureToken = (repository: { owner: string; name: string }) =>
        keymaxxer.findSecret({
          provider: "github",
          account: `${repository.owner}/${repository.name}`,
        })
      const runGitHubCommand = (tokenName: string, command: string) =>
        keymaxxer.runWithSecrets({
          command: `GITHUB_TOKEN="$${tokenName}" ${command}`,
          cwd: options.workspaceRoot,
          secrets: [tokenName],
          timeoutMs: 60_000,
        })
      const runGitHubBin = (
        tokenName: string,
        operation: GitHubHelperOperation,
        args: readonly string[],
      ) =>
        runGitHubCommand(
          tokenName,
          formatGitHubHelperShellCommand(
            resolveGitHubHelperChildSpawn({ operation, args }),
          ),
        )

      const service: GitHubServiceShape = {
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
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(requestError(repository, "merge pull request")),
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
