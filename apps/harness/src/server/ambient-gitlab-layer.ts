import { Deferred, Duration, Effect, Layer, Ref } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  type GitLabProjectUnavailableError,
  GitLabRequestError,
  GitLabService,
  type GitLabServiceShape,
  makeGitLabService,
  makeGitLabServiceFromToken,
} from "@ready-for-agent/gitlab-service"

type GitLabServiceError = GitLabProjectUnavailableError | GitLabRequestError

const authenticationError = (forgeHost: string, cause: unknown) =>
  new GitLabRequestError({
    message: `Failed to resolve GitLab CLI authentication for ${forgeHost}`,
    cause,
  })

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
      const tokenCache = yield* Ref.make<
        ReadonlyMap<string, Deferred.Deferred<string, GitLabRequestError>>
      >(new Map())

      const resolveGlabToken = Effect.fn("AmbientGitLab.resolveGlabToken")(
        function* (forgeHost: string) {
          const output = yield* spawner
            .string(
              ChildProcess.make(
                "glab",
                ["config", "get", "token", "--host", forgeHost],
                {
                  cwd: options.workspaceRoot,
                  stdin: "ignore",
                  stderr: "inherit",
                },
              ),
            )
            .pipe(
              Effect.timeout(Duration.seconds(60)),
              Effect.mapError((cause) => authenticationError(forgeHost, cause)),
            )
          const token = output.trim()
          if (token === "") {
            return yield* authenticationError(
              forgeHost,
              "GitLab CLI did not return an authentication token",
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

      const acquireToken = Effect.fn("AmbientGitLab.acquireToken")(function* (
        forgeHost: string,
      ) {
        const candidate = yield* Deferred.make<string, GitLabRequestError>()
        type SelectedToken = {
          readonly source: Deferred.Deferred<string, GitLabRequestError>
          readonly owner: boolean
        }
        const selected = yield* Ref.modify<
          ReadonlyMap<string, Deferred.Deferred<string, GitLabRequestError>>,
          SelectedToken
        >(tokenCache, (current) => {
          const cached = current.get(forgeHost)
          if (cached !== undefined) {
            return [{ source: cached, owner: false }, current]
          }
          const next = new Map(current)
          next.set(forgeHost, candidate)
          return [{ source: candidate, owner: true }, next]
        })

        if (selected.owner) {
          yield* resolveToken(forgeHost).pipe(
            Effect.result,
            Effect.flatMap((result) =>
              (result._tag === "Failure"
                ? Ref.update(tokenCache, (current) => {
                    if (current.get(forgeHost) !== candidate) return current
                    const next = new Map(current)
                    next.delete(forgeHost)
                    return next
                  })
                : Effect.void
              ).pipe(
                Effect.andThen(
                  Deferred.complete(candidate, Effect.fromResult(result)),
                ),
              ),
            ),
            Effect.forkIn(layerScope, { startImmediately: true }),
          )
        }

        return {
          source: selected.source,
          token: yield* Deferred.await(selected.source),
        }
      })

      const invalidate = (
        forgeHost: string,
        source: Deferred.Deferred<string, GitLabRequestError>,
      ) =>
        Ref.update(tokenCache, (current) => {
          if (current.get(forgeHost) !== source) return current
          const next = new Map(current)
          next.delete(forgeHost)
          return next
        })

      const run = Effect.fn("AmbientGitLab.runAuthenticated")(function* <A>(
        forgeHost: string,
        operation: (
          service: GitLabServiceShape,
        ) => Effect.Effect<A, GitLabServiceError>,
      ) {
        const firstToken = yield* acquireToken(forgeHost)
        const first = yield* Effect.result(
          operation(makeService(firstToken.token)),
        )
        if (
          first._tag !== "Failure" ||
          first.failure._tag !== "GitLabRequestError" ||
          first.failure.statusCode !== 401
        ) {
          return yield* Effect.fromResult(first)
        }

        yield* invalidate(forgeHost, firstToken.source)
        const refreshed = yield* acquireToken(forgeHost)
        return yield* operation(makeService(refreshed.token))
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
