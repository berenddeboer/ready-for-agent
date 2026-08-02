import { Cache, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  type GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  makeGitHubServiceFromToken,
} from "@ready-for-agent/github-service"

type GitHubServiceError = GitHubRepositoryUnavailableError | GitHubRequestError

/** Unit key for the process-wide ambient GitHub CLI token cache. */
const TOKEN_CACHE_KEY = true as const

const authenticationError = (cause: unknown) =>
  new GitHubRequestError({
    message: "Failed to resolve GitHub CLI authentication",
    cause,
  })

export const ambientGitHubLayer = (options: {
  readonly workspaceRoot: string
  readonly resolveToken?: () => Promise<string>
  readonly makeService?: (token: string) => GitHubServiceShape
}): Layer.Layer<
  GitHubService,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const layerScope = yield* Effect.scope
      const makeService = options.makeService ?? makeGitHubServiceFromToken

      const resolveGhToken = Effect.fn("AmbientGitHub.resolveGhToken")(
        function* () {
          const output = yield* spawner
            .string(
              ChildProcess.make("gh", ["auth", "token"], {
                cwd: options.workspaceRoot,
                stdin: "ignore",
                stderr: "inherit",
              }),
            )
            .pipe(Effect.timeout(Duration.seconds(60)))
          const token = output.trim()
          if (token === "") {
            return yield* authenticationError(
              "GitHub CLI did not return an authentication token",
            )
          }
          return token
        },
        Effect.mapError(authenticationError),
      )

      const injectedResolveToken = options.resolveToken
      const resolveToken =
        injectedResolveToken === undefined
          ? resolveGhToken
          : Effect.fn("AmbientGitHub.resolveInjectedToken")(function* () {
              return yield* Effect.tryPromise({
                try: injectedResolveToken,
                catch: authenticationError,
              })
            })

      // Single-flight success cache: concurrent callers share one lookup;
      // failures expire immediately (TTL zero, not reused); success lives until
      // 401 invalidate. Cache.get is forked into the layer scope so canceling one
      // requester cannot abort a shared in-flight lookup for joiners. Nested
      // consumers must build this layer with Layer.buildWithScope (not a
      // short-lived Effect.provide) so that scope stays open.
      const tokenCache = yield* Cache.makeWith(
        (_key: typeof TOKEN_CACHE_KEY) => resolveToken(),
        {
          capacity: 1,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
        },
      )

      const acquireToken = Effect.fn("AmbientGitHub.acquireToken")(
        function* () {
          const fiber = yield* Cache.get(tokenCache, TOKEN_CACHE_KEY).pipe(
            Effect.forkIn(layerScope),
          )
          return yield* Fiber.join(fiber)
        },
      )

      const run = Effect.fn("AmbientGitHub.runAuthenticated")(function* <A>(
        operation: (
          service: GitHubServiceShape,
        ) => Effect.Effect<A, GitHubServiceError>,
      ) {
        const token = yield* acquireToken()
        const first = yield* Effect.result(operation(makeService(token)))
        if (
          first._tag !== "Failure" ||
          first.failure._tag !== "GitHubRequestError" ||
          first.failure.statusCode !== 401
        ) {
          return yield* Effect.fromResult(first)
        }

        // Only drop the cache entry if it still holds the token that 401'd —
        // concurrent 401s share one refresh instead of stomping a newer token.
        yield* Cache.invalidateWhen(
          tokenCache,
          TOKEN_CACHE_KEY,
          (cached) => cached === token,
        )
        const refreshed = yield* acquireToken()
        return yield* operation(makeService(refreshed))
      })

      const authenticated = <A>(
        operation: (
          service: GitHubServiceShape,
        ) => Effect.Effect<A, GitHubServiceError>,
      ): Effect.Effect<A, GitHubServiceError> => run(operation)

      return {
        getAuthenticatedUserLogin: Effect.fn(
          "AmbientGitHub.getAuthenticatedUserLogin",
        )((repository) =>
          authenticated((service) =>
            service.getAuthenticatedUserLogin(repository),
          ),
        ),
        getOpenPullRequestNumber: Effect.fn(
          "AmbientGitHub.getOpenPullRequestNumber",
        )((repository, headRefName) =>
          authenticated((service) =>
            service.getOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        findOpenPullRequestNumber: Effect.fn(
          "AmbientGitHub.findOpenPullRequestNumber",
        )((repository, headRefName) =>
          authenticated((service) =>
            service.findOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        countOpenNonDraftPullRequests: Effect.fn(
          "AmbientGitHub.countOpenNonDraftPullRequests",
        )((repository) =>
          authenticated((service) =>
            service.countOpenNonDraftPullRequests(repository),
          ),
        ),
        createDraftPullRequest: Effect.fn(
          "AmbientGitHub.createDraftPullRequest",
        )((repository, input) =>
          authenticated((service) =>
            service.createDraftPullRequest(repository, input),
          ),
        ),
        updateOpenDraftPullRequestCopy: Effect.fn(
          "AmbientGitHub.updateOpenDraftPullRequestCopy",
        )((repository, headRefName, input) =>
          authenticated((service) =>
            service.updateOpenDraftPullRequestCopy(
              repository,
              headRefName,
              input,
            ),
          ),
        ),
        getPullRequestCheckStatus: Effect.fn(
          "AmbientGitHub.getPullRequestCheckStatus",
        )((repository, headRefName) =>
          authenticated((service) =>
            service.getPullRequestCheckStatus(repository, headRefName),
          ),
        ),
        getPrStatusCheckDiagnostics: Effect.fn(
          "AmbientGitHub.getPrStatusCheckDiagnostics",
        )((repository, checks, requestOptions) =>
          authenticated((service) =>
            service.getPrStatusCheckDiagnostics(
              repository,
              checks,
              requestOptions,
            ),
          ),
        ),
        observeAutomatedReviewEvidence: Effect.fn(
          "AmbientGitHub.observeAutomatedReviewEvidence",
        )((repository, headRefName, checks) =>
          authenticated((service) =>
            service.observeAutomatedReviewEvidence(
              repository,
              headRefName,
              checks,
            ),
          ),
        ),
        getPullRequestLifecycleStatus: Effect.fn(
          "AmbientGitHub.getPullRequestLifecycleStatus",
        )((repository, headRefName) =>
          authenticated((service) =>
            service.getPullRequestLifecycleStatus(repository, headRefName),
          ),
        ),
        markPullRequestReadyForReview: Effect.fn(
          "AmbientGitHub.markPullRequestReadyForReview",
        )((repository, headRefName) =>
          authenticated((service) =>
            service.markPullRequestReadyForReview(repository, headRefName),
          ),
        ),
        mergePullRequest: Effect.fn("AmbientGitHub.mergePullRequest")(
          (repository, headRefName) =>
            authenticated((service) =>
              service.mergePullRequest(repository, headRefName),
            ),
        ),
        rerunWorkflowRun: Effect.fn("AmbientGitHub.rerunWorkflowRun")(
          (repository, workflowRunId) =>
            authenticated((service) =>
              service.rerunWorkflowRun(repository, workflowRunId),
            ),
        ),
        ensureIssueCompletedWithSummary: Effect.fn(
          "AmbientGitHub.ensureIssueCompletedWithSummary",
        )((repository, issueNumber, workItemId, summaryMarkdown) =>
          authenticated((service) =>
            service.ensureIssueCompletedWithSummary(
              repository,
              issueNumber,
              workItemId,
              summaryMarkdown,
            ),
          ),
        ),
        listReadyIssues: Effect.fn("AmbientGitHub.listReadyIssues")(
          (repository) =>
            authenticated((service) => service.listReadyIssues(repository)),
        ),
      } satisfies GitHubServiceShape
    }),
  )
