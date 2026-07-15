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
})

const SerializedIssues = Schema.Array(SerializedIssue)
const SerializedPullRequestCheckStatus = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("succeeded", {}),
  Schema.TaggedStruct("failed", {}),
  Schema.TaggedStruct("closed", {}),
])

const requestError = (repository: { owner: string; name: string }) =>
  new GitHubRequestError({
    message: `Failed to list Ready-labeled Issues for ${repository.owner}/${repository.name}`,
  })

const encodeArgument = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const parseIssues = (
  stdout: string,
  repository: { owner: string; name: string },
): Effect.Effect<readonly ReadyLabeledIssue[], GitHubRequestError> =>
  Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: () => requestError(repository),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(SerializedIssues)(value).pipe(
        Effect.mapError(() => requestError(repository)),
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
            return { ...issue, createdAt }
          }),
        catch: () => requestError(repository),
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
        getPullRequestCheckStatus: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(repository)
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
              return yield* requestError(repository)
            }
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(SerializedPullRequestCheckStatus),
            )(result.stdout).pipe(
              Effect.mapError(() => requestError(repository)),
            )
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(requestError(repository)),
            ),
          ),
        markPullRequestReadyForReview: (repository, headRefName) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(repository)
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
              return yield* requestError(repository)
            }
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(requestError(repository)),
            ),
          ),
        listReadyIssues: (repository) =>
          Effect.gen(function* () {
            const tokenName = yield* ensureToken(repository)
            if (tokenName === null) {
              return yield* requestError(repository)
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
              return yield* requestError(repository)
            }
            return yield* parseIssues(result.stdout, repository)
          }).pipe(
            Effect.catchTag("KeymaxxerError", () =>
              Effect.fail(requestError(repository)),
            ),
          ),
      }

      return service
    }),
  )
