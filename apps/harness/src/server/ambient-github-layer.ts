import { Deferred, Duration, Effect, Layer, Ref } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  type GitHubRepositoryUnavailableError,
  GitHubRequestError,
  GitHubService,
  type GitHubServiceShape,
  makeGitHubServiceFromToken,
} from "@ready-for-agent/github-service"

type GitHubServiceError = GitHubRepositoryUnavailableError | GitHubRequestError

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
      const makeService = options.makeService ?? makeGitHubServiceFromToken
      const tokenCache = yield* Ref.make<
        Deferred.Deferred<string, GitHubRequestError> | undefined
      >(undefined)

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

      const acquireToken = Effect.fn("AmbientGitHub.acquireToken")(
        function* () {
          const candidate = yield* Deferred.make<string, GitHubRequestError>()
          type SelectedToken = {
            readonly source: Deferred.Deferred<string, GitHubRequestError>
            readonly owner: boolean
          }
          const selected = yield* Ref.modify<
            Deferred.Deferred<string, GitHubRequestError> | undefined,
            SelectedToken
          >(tokenCache, (current) =>
            current === undefined
              ? [{ source: candidate, owner: true }, candidate]
              : [{ source: current, owner: false }, current],
          )

          if (selected.owner) {
            yield* resolveToken().pipe(
              Effect.result,
              Effect.flatMap((result) =>
                (result._tag === "Failure"
                  ? Ref.update(tokenCache, (current) =>
                      current === candidate ? undefined : current,
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Deferred.complete(candidate, Effect.fromResult(result)),
                  ),
                ),
              ),
              Effect.forkDetach({ startImmediately: true }),
            )
          }

          return {
            source: selected.source,
            token: yield* Deferred.await(selected.source),
          }
        },
      )

      const run = Effect.fn("AmbientGitHub.runAuthenticated")(function* <A>(
        operation: (
          service: GitHubServiceShape,
        ) => Effect.Effect<A, GitHubServiceError>,
      ) {
        const { source, token } = yield* acquireToken()
        const first = yield* Effect.result(operation(makeService(token)))
        if (
          first._tag !== "Failure" ||
          first.failure._tag !== "GitHubRequestError" ||
          first.failure.statusCode !== 401
        ) {
          return yield* Effect.fromResult(first)
        }

        yield* Ref.update(tokenCache, (current) =>
          current === source ? undefined : current,
        )
        const refreshed = yield* acquireToken()
        return yield* operation(makeService(refreshed.token))
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
