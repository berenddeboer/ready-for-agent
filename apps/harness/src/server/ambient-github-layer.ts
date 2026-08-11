import { Cache, Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  type GitHubOperationOptions,
  type GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  type GitHubThrottledError,
  extractErrorCode,
  isGitHubThrottledError,
  makeGitHubServiceFromToken,
} from "@ready-for-agent/github-service"
import {
  GitHubOperationCoordinator,
  type GitHubOperationOrigin,
} from "./github-operation-coordinator.js"

type GitHubServiceError =
  | GitHubRepositoryUnavailableError
  | GitHubRequestError
  | GitHubThrottledError

/** Unit key for the process-wide ambient GitHub CLI token cache. */
const TOKEN_CACHE_KEY = true as const

/**
 * Identity is scoped to a Repository credential path, rather than to the
 * process-wide ambient token cache. This prevents similarly timed
 * reconciliation of different Repositories from accidentally sharing an
 * Operator Forge User result.
 */
const authenticatedUserCacheKey = (repository: {
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}): string =>
  [
    repository.forge.toLowerCase(),
    repository.forgeHost.toLowerCase(),
    repository.projectPath.toLowerCase(),
  ].join("\0")

const authenticationError = (cause: unknown) => {
  const code = extractErrorCode(cause)
  return new GitHubRequestError({
    message: "Failed to resolve GitHub CLI authentication",
    cause,
    ...(code !== undefined ? { code } : {}),
  })
}

export const ambientGitHubLayer = (options: {
  readonly workspaceRoot: string
  readonly resolveToken?: () => Promise<string>
  readonly makeService?: (
    token: string,
    observeThrottle: (throttle: GitHubThrottledError) => void,
  ) => GitHubServiceShape
}): Layer.Layer<
  GitHubService,
  never,
  ChildProcessSpawner.ChildProcessSpawner | GitHubOperationCoordinator
> =>
  Layer.effect(
    GitHubService,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coordinator = yield* GitHubOperationCoordinator
      const layerScope = yield* Effect.scope
      const makeService =
        options.makeService ??
        ((
          token: string,
          observeThrottle: (throttle: GitHubThrottledError) => void,
        ) =>
          makeGitHubServiceFromToken(
            token,
            undefined,
            undefined,
            observeThrottle,
          ))

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

      // Ambient authentication has one process-wide credential. A 401 means
      // every Repository-scoped identity derived from it is stale, even when
      // a different Repository observed the failure.
      let invalidateAuthenticatedUsers: Effect.Effect<void> = Effect.void

      const run = Effect.fn("AmbientGitHub.runAuthenticated")(function* <A>(
        _repository: Parameters<
          GitHubServiceShape["getAuthenticatedUserLogin"]
        >[0],
        operation: (
          service: GitHubServiceShape,
        ) => Effect.Effect<A, GitHubServiceError>,
      ) {
        const token = yield* acquireToken()
        const first = yield* Effect.result(
          operation(makeService(token, coordinator.reportThrottle)),
        )
        if (
          first._tag !== "Failure" ||
          first.failure._tag !== "GitHubRequestError" ||
          first.failure.statusCode !== 401
        ) {
          return yield* Effect.fromResult(first)
        }

        // Only drop the cache entry if it still holds the token that 401'd —
        // concurrent 401s share one refresh instead of stomping a newer token.
        yield* invalidateAuthenticatedUsers
        yield* Cache.invalidateWhen(
          tokenCache,
          TOKEN_CACHE_KEY,
          (cached) => cached === token,
        )
        const refreshed = yield* acquireToken()
        return yield* operation(
          makeService(refreshed, coordinator.reportThrottle),
        )
      })

      const authenticated = <A>(
        origin: GitHubOperationOrigin,
        repository: Parameters<
          GitHubServiceShape["getAuthenticatedUserLogin"]
        >[0],
        operation: (
          service: GitHubServiceShape,
        ) => Effect.Effect<A, GitHubServiceError>,
      ): Effect.Effect<A, GitHubServiceError> =>
        coordinator.execute({
          origin,
          operation: run(repository, operation).pipe(
            Effect.catchIf(isGitHubThrottledError, (throttle) =>
              Effect.fail(coordinator.reportThrottle(throttle)),
            ),
          ),
        })

      const authenticatedUserLookupsByCacheKey = new Map<
        string,
        {
          readonly repository: Parameters<
            GitHubServiceShape["getAuthenticatedUserLogin"]
          >[0]
          readonly origin: GitHubOperationOrigin
        }
      >()
      const authenticatedUserCache = yield* Cache.makeWith(
        (key: string) => {
          const lookup = authenticatedUserLookupsByCacheKey.get(key)
          if (lookup === undefined) {
            return Effect.fail(
              authenticationError("Missing Repository identity cache key"),
            )
          }
          return authenticated(lookup.origin, lookup.repository, (service) =>
            service.getAuthenticatedUserLogin(lookup.repository, {
              origin: lookup.origin,
            }),
          )
        },
        {
          capacity: 256,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
        },
      )

      invalidateAuthenticatedUsers = Cache.invalidateAll(authenticatedUserCache)

      const getAuthenticatedUserLogin = Effect.fn(
        "AmbientGitHub.getAuthenticatedUserLogin",
      )(function* (
        repository: Parameters<
          GitHubServiceShape["getAuthenticatedUserLogin"]
        >[0],
        operationOptions?: GitHubOperationOptions,
      ) {
        const key = authenticatedUserCacheKey(repository)
        authenticatedUserLookupsByCacheKey.set(key, {
          repository,
          origin: operationOptions?.origin ?? "polling",
        })
        const cached = yield* Cache.getSuccess(authenticatedUserCache, key)
        if (Option.isSome(cached)) return cached.value

        // Cache owns the lookup for the application scope, so a canceled
        // caller cannot tear down a concurrent reconciliation's identity work.
        const lookup = yield* Cache.get(authenticatedUserCache, key).pipe(
          Effect.forkIn(layerScope),
        )
        return yield* Fiber.join(lookup)
      })

      return {
        getAuthenticatedUserLogin,
        getOpenPullRequestNumber: Effect.fn(
          "AmbientGitHub.getOpenPullRequestNumber",
        )((repository, headRefName) =>
          authenticated("lifecycle", repository, (service) =>
            service.getOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        findOpenPullRequestNumber: Effect.fn(
          "AmbientGitHub.findOpenPullRequestNumber",
        )((repository, headRefName) =>
          authenticated("lifecycle", repository, (service) =>
            service.findOpenPullRequestNumber(repository, headRefName),
          ),
        ),
        closeOpenPullRequestsAndDeleteBranch: Effect.fn(
          "AmbientGitHub.closeOpenPullRequestsAndDeleteBranch",
        )((repository, headRefName) =>
          authenticated("operator", repository, (service) =>
            service.closeOpenPullRequestsAndDeleteBranch(
              repository,
              headRefName,
            ),
          ),
        ),
        countOpenNonDraftPullRequests: Effect.fn(
          "AmbientGitHub.countOpenNonDraftPullRequests",
        )((repository) =>
          authenticated("background", repository, (service) =>
            service.countOpenNonDraftPullRequests(repository),
          ),
        ),
        createDraftPullRequest: Effect.fn(
          "AmbientGitHub.createDraftPullRequest",
        )((repository, input) =>
          authenticated("lifecycle", repository, (service) =>
            service.createDraftPullRequest(repository, input),
          ),
        ),
        updateOpenDraftPullRequestCopy: Effect.fn(
          "AmbientGitHub.updateOpenDraftPullRequestCopy",
        )((repository, headRefName, input) =>
          authenticated("lifecycle", repository, (service) =>
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
          authenticated("lifecycle", repository, (service) =>
            service.getPullRequestCheckStatus(repository, headRefName),
          ),
        ),
        getPrStatusCheckDiagnostics: Effect.fn(
          "AmbientGitHub.getPrStatusCheckDiagnostics",
        )((repository, checks, requestOptions) =>
          authenticated("lifecycle", repository, (service) =>
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
          authenticated("lifecycle", repository, (service) =>
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
          authenticated("lifecycle", repository, (service) =>
            service.getPullRequestLifecycleStatus(repository, headRefName),
          ),
        ),
        markPullRequestReadyForReview: Effect.fn(
          "AmbientGitHub.markPullRequestReadyForReview",
        )((repository, headRefName) =>
          authenticated("lifecycle", repository, (service) =>
            service.markPullRequestReadyForReview(repository, headRefName),
          ),
        ),
        mergePullRequest: Effect.fn("AmbientGitHub.mergePullRequest")(
          (repository, headRefName) =>
            authenticated("lifecycle", repository, (service) =>
              service.mergePullRequest(repository, headRefName),
            ),
        ),
        rerunWorkflowRun: Effect.fn("AmbientGitHub.rerunWorkflowRun")(
          (repository, workflowRunId) =>
            authenticated("lifecycle", repository, (service) =>
              service.rerunWorkflowRun(repository, workflowRunId),
            ),
        ),
        ensureIssueCompletedWithSummary: Effect.fn(
          "AmbientGitHub.ensureIssueCompletedWithSummary",
        )((repository, issueNumber, workItemId, summaryMarkdown) =>
          authenticated("lifecycle", repository, (service) =>
            service.ensureIssueCompletedWithSummary(
              repository,
              issueNumber,
              workItemId,
              summaryMarkdown,
            ),
          ),
        ),
        listReadyIssues: Effect.fn("AmbientGitHub.listReadyIssues")(
          (repository, operationOptions?: GitHubOperationOptions) =>
            authenticated(
              operationOptions?.origin ?? "polling",
              repository,
              (service) =>
                service.listReadyIssues(repository, operationOptions),
            ),
        ),
      } satisfies GitHubServiceShape
    }),
  )
