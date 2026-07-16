import { Effect, Layer, Schema } from "effect"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  type ReadyLabeledIssue,
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
    }),
  ),
})

const SerializedIssues = Schema.Array(SerializedIssue)
const SerializedTerminalPrStatusCheck = Schema.Struct({
  externalId: Schema.String,
  name: Schema.String,
  outcome: Schema.Literals(["green", "red"]),
})

const SerializedPullRequestCheckStatus = Schema.Union([
  Schema.TaggedStruct("pending", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
  }),
  Schema.TaggedStruct("no_checks", {}),
  Schema.TaggedStruct("succeeded", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
  }),
  Schema.TaggedStruct("failed", {
    terminalChecks: Schema.Array(SerializedTerminalPrStatusCheck),
  }),
  Schema.TaggedStruct("closed", {}),
])

const requestError = (
  repository: { owner: string; name: string },
  operation: string,
  detail?: string,
) =>
  new GitHubRequestError({
    message:
      detail === undefined || detail.trim() === ""
        ? `Failed to ${operation} for ${repository.owner}/${repository.name}`
        : `Failed to ${operation} for ${repository.owner}/${repository.name}: ${detail.trim().slice(0, 300)}`,
  })

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
            const result = yield* keymaxxer.runWithSecrets({
              command: `GITHUB_TOKEN="$${tokenName}" bun --conditions @ready-for-agent/source packages/github-service/src/bin/get-open-pr-number.ts ${owner} ${name} ${head}`,
              cwd: options.workspaceRoot,
              secrets: [tokenName],
              timeoutMs: 60_000,
            })
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
            const result = yield* keymaxxer.runWithSecrets({
              command: `GITHUB_TOKEN="$${tokenName}" bun --conditions @ready-for-agent/source packages/github-service/src/bin/get-pr-check-status.ts ${owner} ${name} ${head}`,
              cwd: options.workspaceRoot,
              secrets: [tokenName],
              timeoutMs: 60_000,
            })
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
            const result = yield* keymaxxer.runWithSecrets({
              command: `GITHUB_TOKEN="$${tokenName}" bun --conditions @ready-for-agent/source packages/github-service/src/bin/mark-pr-ready-for-review.ts ${owner} ${name} ${head}`,
              cwd: options.workspaceRoot,
              secrets: [tokenName],
              timeoutMs: 60_000,
            })
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
            const result = yield* keymaxxer.runWithSecrets({
              command: `GITHUB_TOKEN="$${tokenName}" bun --conditions @ready-for-agent/source packages/github-service/src/bin/merge-pull-request.ts ${owner} ${name} ${head}`,
              cwd: options.workspaceRoot,
              secrets: [tokenName],
              timeoutMs: 60_000,
            })
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
            const result = yield* keymaxxer.runWithSecrets({
              command: `GITHUB_TOKEN="$${tokenName}" bun --conditions @ready-for-agent/source packages/github-service/src/bin/list-ready-issues.ts ${owner} ${name}`,
              cwd: options.workspaceRoot,
              secrets: [tokenName],
              timeoutMs: 60_000,
            })

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
