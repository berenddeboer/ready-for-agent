import { Effect, Layer, Schema, Semaphore } from "effect"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  type ReadyLabeledIssue,
} from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"

const githubTokenName = "GITHUB_TOKEN"

const SerializedIssue = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  blockedBy: Schema.Array(
    Schema.Struct({
      number: Schema.Finite,
      url: Schema.String,
    }),
  ),
})

const SerializedIssues = Schema.Array(SerializedIssue)

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
      const tokenProvisioning = yield* Semaphore.make(1)
      const ensureToken = tokenProvisioning.withPermits(1)(
        Effect.gen(function* () {
          if (yield* keymaxxer.hasSecret(githubTokenName)) return true

          return yield* keymaxxer.addSecret({
            name: githubTokenName,
            provider: "github",
            description: "GitHub token used to refresh configured Repositories",
            tags: "ready-for-agent,harness,github",
          })
        }),
      )

      const service: GitHubServiceShape = {
        listReadyIssues: (repository) =>
          Effect.gen(function* () {
            if (!(yield* ensureToken)) return yield* requestError(repository)

            const owner = encodeArgument(repository.owner)
            const name = encodeArgument(repository.name)
            const result = yield* keymaxxer.runWithSecrets({
              command: `bun --conditions @ready-for-agent/source packages/github-service/src/bin/list-ready-issues.ts ${owner} ${name}`,
              cwd: options.workspaceRoot,
              secrets: [githubTokenName],
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
