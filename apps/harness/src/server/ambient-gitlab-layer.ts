import { Cache, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { extractErrorCode } from "@ready-for-agent/github-service"
import {
  type GitLabProjectUnavailableError,
  GitLabRequestError,
  GitLabService,
  type GitLabServiceShape,
  makeGitLabService,
  makeGitLabServiceFromToken,
  resolveGlabHostToken,
} from "@ready-for-agent/gitlab-service"

type GitLabServiceError = GitLabProjectUnavailableError | GitLabRequestError

const authenticationError = (forgeHost: string, cause: unknown) => {
  const code = extractErrorCode(cause)
  return new GitLabRequestError({
    message: `Failed to resolve GitLab CLI authentication for ${forgeHost}`,
    cause,
    ...(code !== undefined ? { code } : {}),
  })
}

export const ambientGitLabLayer = (options: {
  readonly workspaceRoot: string
  readonly environment?: Partial<Record<string, string | undefined>>
  readonly resolveToken?: (forgeHost: string) => Promise<string>
  readonly makeService?: (token: string) => GitLabServiceShape
  readonly makeAnonymousService?: () => GitLabServiceShape
}): Layer.Layer<
  GitLabService,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    GitLabService,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const layerScope = yield* Effect.scope
      const makeService = options.makeService ?? makeGitLabServiceFromToken
      const makeAnonymousService =
        options.makeAnonymousService ?? (() => makeGitLabService({}))
      const ambientToken = options.environment?.GITLAB_TOKEN?.trim()

      const resolveGlabToken = Effect.fn("AmbientGitLab.resolveGlabToken")(
        function* (forgeHost: string) {
          // Host-specific: shared helper uses `glab auth status --hostname
          // --show-token` so unconfigured hosts (and config-get fallback tokens)
          // are rejected, while local tokens still work when the Forge API is
          // briefly unreachable.
          const token = yield* resolveGlabHostToken({
            forgeHost,
            spawner,
            cwd: options.workspaceRoot,
          })
          if (token === null) {
            return yield* authenticationError(
              forgeHost,
              `GitLab CLI is not authenticated for ${forgeHost}`,
            )
          }
          return token
        },
      )

      const resolveToken = Effect.fn("AmbientGitLab.resolveToken")(function* (
        forgeHost: string,
      ) {
        if (ambientToken !== undefined && ambientToken !== "") {
          return ambientToken
        }
        const injectedResolveToken = options.resolveToken
        if (injectedResolveToken === undefined) {
          return yield* resolveGlabToken(forgeHost)
        }
        return yield* Effect.tryPromise({
          try: () => injectedResolveToken(forgeHost),
          catch: (cause) => authenticationError(forgeHost, cause),
        }).pipe(
          Effect.flatMap((token) =>
            token.trim() === ""
              ? Effect.fail(
                  authenticationError(
                    forgeHost,
                    "GitLab token resolver returned an empty token",
                  ),
                )
              : Effect.succeed(token.trim()),
          ),
        )
      })

      // Per-host single-flight success cache; failures expire immediately
      // (TTL zero, not reused); success lives until 401 invalidate. Capacity is
      // unbounded (same as the prior Map) so multi-host installs are not
      // evicted. Cache.get is forked into the layer scope so canceling one
      // requester cannot abort a shared in-flight lookup for joiners. Nested
      // consumers must build this layer with Layer.buildWithScope (not a
      // short-lived Effect.provide) so that scope stays open.
      const tokenCache = yield* Cache.makeWith(
        (forgeHost: string) => resolveToken(forgeHost),
        {
          capacity: Number.POSITIVE_INFINITY,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
        },
      )

      const acquireToken = Effect.fn("AmbientGitLab.acquireToken")(function* (
        forgeHost: string,
      ) {
        const fiber = yield* Cache.get(tokenCache, forgeHost).pipe(
          Effect.forkIn(layerScope),
        )
        return yield* Fiber.join(fiber)
      })

      const run = Effect.fn("AmbientGitLab.runAuthenticated")(function* <A>(
        forgeHost: string,
        operation: (
          service: GitLabServiceShape,
        ) => Effect.Effect<A, GitLabServiceError>,
      ) {
        const token = yield* acquireToken(forgeHost)
        const first = yield* Effect.result(operation(makeService(token)))
        if (
          first._tag !== "Failure" ||
          first.failure._tag !== "GitLabRequestError" ||
          first.failure.statusCode !== 401
        ) {
          return yield* Effect.fromResult(first)
        }

        // Only drop the entry if it still holds the token that 401'd —
        // concurrent 401s share one refresh instead of stomping a newer token.
        yield* Cache.invalidateWhen(
          tokenCache,
          forgeHost,
          (cached) => cached === token,
        )
        const refreshed = yield* acquireToken(forgeHost)
        return yield* operation(makeService(refreshed))
      })

      const authenticated = <A>(
        forgeHost: string,
        operation: (
          service: GitLabServiceShape,
        ) => Effect.Effect<A, GitLabServiceError>,
      ): Effect.Effect<A, GitLabServiceError> => run(forgeHost, operation)

      return {
        verifyProject: Effect.fn("AmbientGitLab.verifyProject")((repository) =>
          authenticated(repository.forgeHost, (service) =>
            service.verifyProject(repository),
          ).pipe(
            Effect.catchTag("GitLabRequestError", (error) =>
              error.statusCode === undefined
                ? makeAnonymousService().verifyProject(repository)
                : Effect.fail(error),
            ),
          ),
        ),
        getAuthenticatedUserLogin: Effect.fn(
          "AmbientGitLab.getAuthenticatedUserLogin",
        )((repository) =>
          authenticated(repository.forgeHost, (service) =>
            service.getAuthenticatedUserLogin(repository),
          ),
        ),
        listReadyIssues: Effect.fn("AmbientGitLab.listReadyIssues")(
          (repository) =>
            authenticated(repository.forgeHost, (service) =>
              service.listReadyIssues(repository),
            ),
        ),
        hasCredentials: Effect.fn("AmbientGitLab.hasCredentials")(
          (repository) =>
            acquireToken(repository.forgeHost).pipe(
              Effect.as(true),
              Effect.catchTag("GitLabRequestError", () =>
                Effect.succeed(false),
              ),
            ),
        ),
        hasAmbientCredentials: Effect.fn("AmbientGitLab.hasAmbientCredentials")(
          (repository) =>
            acquireToken(repository.forgeHost).pipe(
              Effect.as(true),
              Effect.catchTag("GitLabRequestError", () =>
                Effect.succeed(false),
              ),
            ),
        ),
        getOpenPullRequestNumber: Effect.fn(
          "AmbientGitLab.getOpenPullRequestNumber",
        )((repository, headRefName) =>
          authenticated(repository.forgeHost, (service) =>
            service.getOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        findOpenPullRequestNumber: Effect.fn(
          "AmbientGitLab.findOpenPullRequestNumber",
        )((repository, headRefName) =>
          authenticated(repository.forgeHost, (service) =>
            service.findOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        createDraftPullRequest: Effect.fn(
          "AmbientGitLab.createDraftPullRequest",
        )((repository, input) =>
          authenticated(repository.forgeHost, (service) =>
            service.createDraftPullRequest(repository, input),
          ),
        ),
        updateOpenDraftPullRequestCopy: Effect.fn(
          "AmbientGitLab.updateOpenDraftPullRequestCopy",
        )((repository, headRefName, input) =>
          authenticated(repository.forgeHost, (service) =>
            service.updateOpenDraftPullRequestCopy(
              repository,
              headRefName,
              input,
            ),
          ),
        ),
        countOpenNonDraftPullRequests: Effect.fn(
          "AmbientGitLab.countOpenNonDraftPullRequests",
        )((repository) =>
          authenticated(repository.forgeHost, (service) =>
            service.countOpenNonDraftPullRequests(repository),
          ),
        ),
        getPullRequestCheckStatus: Effect.fn(
          "AmbientGitLab.getPullRequestCheckStatus",
        )((repository, headRefName) =>
          authenticated(repository.forgeHost, (service) =>
            service.getPullRequestCheckStatus(repository, headRefName),
          ),
        ),
        getPrStatusCheckDiagnostics: Effect.fn(
          "AmbientGitLab.getPrStatusCheckDiagnostics",
        )((repository, checks, options = {}) =>
          authenticated(repository.forgeHost, (service) =>
            service.getPrStatusCheckDiagnostics(repository, checks, options),
          ),
        ),
        markPullRequestReadyForReview: Effect.fn(
          "AmbientGitLab.markPullRequestReadyForReview",
        )((repository, headRefName) =>
          authenticated(repository.forgeHost, (service) =>
            service.markPullRequestReadyForReview(repository, headRefName),
          ),
        ),
        getPullRequestLifecycleStatus: Effect.fn(
          "AmbientGitLab.getPullRequestLifecycleStatus",
        )((repository, headRefName) =>
          authenticated(repository.forgeHost, (service) =>
            service.getPullRequestLifecycleStatus(repository, headRefName),
          ),
        ),
        mergePullRequest: Effect.fn("AmbientGitLab.mergePullRequest")(
          (repository, headRefName) =>
            authenticated(repository.forgeHost, (service) =>
              service.mergePullRequest(repository, headRefName),
            ),
        ),
        ensureIssueCompletedWithSummary: Effect.fn(
          "AmbientGitLab.ensureIssueCompletedWithSummary",
        )((repository, issueNumber, workItemId, summaryMarkdown) =>
          authenticated(repository.forgeHost, (service) =>
            service.ensureIssueCompletedWithSummary(
              repository,
              issueNumber,
              workItemId,
              summaryMarkdown,
            ),
          ),
        ),
        closeOpenPullRequestsForBranch: Effect.fn(
          "AmbientGitLab.closeOpenPullRequestsForBranch",
        )((repository, headRefName) =>
          authenticated(repository.forgeHost, (service) =>
            service.closeOpenPullRequestsForBranch(repository, headRefName),
          ),
        ),
        deleteBranch: Effect.fn("AmbientGitLab.deleteBranch")(
          (repository, branchName) =>
            authenticated(repository.forgeHost, (service) =>
              service.deleteBranch(repository, branchName),
            ),
        ),
      }
    }),
  )
