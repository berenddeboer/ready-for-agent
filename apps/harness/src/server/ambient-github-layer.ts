import { spawn } from "node:child_process"
import { Effect, Layer } from "effect"
import {
  type GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  makeGitHubServiceFromToken,
} from "@ready-for-agent/github-service"

type GitHubServiceError = GitHubRepositoryUnavailableError | GitHubRequestError

const resolveGhToken = (cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", ["auth", "token"], {
      cwd,
      env: process.env,
      timeout: 60_000,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (exitCode) => {
      const token = stdout.trim()
      if (exitCode === 0 && token !== "") {
        resolve(token)
        return
      }
      reject(
        new Error(
          stderr.trim() || "GitHub CLI did not return an authentication token",
        ),
      )
    })
  })

export const ambientGitHubLayer = (options: {
  readonly workspaceRoot: string
  readonly resolveToken?: () => Promise<string>
  readonly makeService?: (token: string) => GitHubServiceShape
}): Layer.Layer<GitHubService> =>
  Layer.sync(GitHubService, () => {
    const resolveToken =
      options.resolveToken ?? (() => resolveGhToken(options.workspaceRoot))
    const makeService = options.makeService ?? makeGitHubServiceFromToken
    type TokenEntry = { readonly promise: Promise<string> }
    let cachedToken: TokenEntry | undefined

    const acquireToken = () => {
      const source = cachedToken ?? { promise: resolveToken() }
      cachedToken = source
      return source.promise.then(
        (token) => ({ source, token }),
        (error) => {
          if (cachedToken === source) cachedToken = undefined
          throw error
        },
      )
    }

    const run = <A>(
      operation: (
        service: GitHubServiceShape,
      ) => Effect.Effect<A, GitHubServiceError>,
      refreshAuthentication: boolean,
    ): Effect.Effect<A, GitHubServiceError> =>
      Effect.tryPromise({
        try: acquireToken,
        catch: (cause) =>
          new GitHubRequestError({
            message: "Failed to resolve GitHub CLI authentication",
            cause,
          }),
      }).pipe(
        Effect.flatMap(({ source, token }) =>
          operation(makeService(token)).pipe(
            Effect.catchTag("GitHubRequestError", (error) => {
              if (!refreshAuthentication || error.statusCode !== 401) {
                return Effect.fail(error)
              }
              if (cachedToken === source) cachedToken = undefined
              return run(operation, false)
            }),
          ),
        ),
      )

    const authenticated = <A>(
      operation: (
        service: GitHubServiceShape,
      ) => Effect.Effect<A, GitHubServiceError>,
    ): Effect.Effect<A, GitHubServiceError> => run(operation, true)

    return {
      getOpenPullRequestNumber: (repository, headRefName) =>
        authenticated((service) =>
          service.getOpenPullRequestNumber(repository, headRefName),
        ),
      getPullRequestCheckStatus: (repository, headRefName) =>
        authenticated((service) =>
          service.getPullRequestCheckStatus(repository, headRefName),
        ),
      getPrStatusCheckDiagnostics: (repository, checks, options) =>
        authenticated((service) =>
          service.getPrStatusCheckDiagnostics(repository, checks, options),
        ),
      getPullRequestLifecycleStatus: (repository, headRefName) =>
        authenticated((service) =>
          service.getPullRequestLifecycleStatus(repository, headRefName),
        ),
      markPullRequestReadyForReview: (repository, headRefName) =>
        authenticated((service) =>
          service.markPullRequestReadyForReview(repository, headRefName),
        ),
      mergePullRequest: (repository, headRefName) =>
        authenticated((service) =>
          service.mergePullRequest(repository, headRefName),
        ),
      listReadyIssues: (repository) =>
        authenticated((service) => service.listReadyIssues(repository)),
    } satisfies GitHubServiceShape
  })
