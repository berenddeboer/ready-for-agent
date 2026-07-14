import {
  Data,
  Effect,
  type ManagedRuntime,
  Result,
  Semaphore,
  Stream,
} from "effect"
import { GraphQLError } from "graphql"
import { createSchema, createYoga } from "graphql-yoga"
import {
  DatabaseError,
  DbService,
  InvalidConfigInputError,
  InvalidRepositoryInputError,
  type IssueRecord,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
  RepositoryId,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "@ready-for-agent/github-service"
import { typeDefs } from "@ready-for-agent/graphql-schema"
import {
  type IssueReconciler,
  ReconciliationMutationError,
} from "@ready-for-agent/issue-reconciler"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import { EnqueueError, QueueService } from "@ready-for-agent/queue-service"
import {
  ActiveStepRunExistsError,
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  ParentIssueError,
  ResetCleanupError,
  RetryNotEligibleError,
  UnfinishedWorkItemExistsError,
  WorkItemLifecycle,
  WorkItemLifecycleDatabaseError,
  WorkItemNotFoundError,
  WorkItemTerminalError,
} from "@ready-for-agent/work-item-lifecycle"

type AddRepositoryArgs = {
  input: {
    githubOwner: string
    githubRepo: string
    localPath: string
    isBare: boolean
  }
}

type RefreshRepositoryArgs = {
  repositoryId: string
}

type RemoveRepositoryArgs = {
  repositoryId: string
}

type RepositoryCredentialArgs = {
  repositoryId: string
}

type UpdateConfigArgs = {
  input: {
    defaultModel: string
    defaultVariant: string
  }
}

type IssuesArgs = {
  repositoryId: string
}

type WorkItemsArgs = IssuesArgs & {
  githubIssueNumber?: number
}

type ImplementNowArgs = IssuesArgs & {
  githubIssueNumber: number
}

type WorkItemArgs = {
  workItemId: string
}

type ResetWorkItemArgs = WorkItemArgs

const childIssueCategory = (issue: IssueRecord): number => {
  if (issue.state === "CLOSED") return 2
  return issue.blockedBy.length === 0 ? 0 : 1
}

const compareChildIssues = (left: IssueRecord, right: IssueRecord): number =>
  childIssueCategory(left) - childIssueCategory(right) ||
  (left.parentPosition ?? Number.MAX_SAFE_INTEGER) -
    (right.parentPosition ?? Number.MAX_SAFE_INTEGER) ||
  left.githubIssueNumber - right.githubIssueNumber

const workIssueProjection = (
  issues: readonly IssueRecord[],
): readonly IssueRecord[] => {
  const childrenByParent = new Map<number, IssueRecord[]>()
  for (const issue of issues) {
    if (issue.parent === null) continue
    const children = childrenByParent.get(issue.parent.githubIssueNumber) ?? []
    children.push(issue)
    childrenByParent.set(issue.parent.githubIssueNumber, children)
  }

  return issues
    .filter((issue) => issue.parent === null)
    .sort((left, right) => left.githubIssueNumber - right.githubIssueNumber)
    .flatMap((issue) => {
      if (!issue.hasChildren) return [issue]
      const children = childrenByParent.get(issue.githubIssueNumber) ?? []
      if (children.length === 0) return []
      return [issue, ...children.sort(compareChildIssues)]
    })
}

export type GraphqlRuntime = ManagedRuntime.ManagedRuntime<
  | DbService
  | IssueReconciler
  | KeymaxxerService
  | Opencode
  | QueueService
  | WorkItemLifecycle,
  unknown
>

const JOBS_QUEUE = "jobs"
const JOB_RECOVERY_RETRY_LIMIT = 1

type Repository = {
  id: string
  githubOwner: string
  githubRepo: string
}

class RepositoryCredentialError extends Data.TaggedError(
  "RepositoryCredentialError",
)<{ readonly message: string }> {}

const githubTokenSecretName = (repository: Repository) =>
  `GITHUB_TOKEN_${repository.githubOwner}_${repository.githubRepo}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()

const githubTokenCreationUrl = (repository: Repository) => {
  const url = new URL("https://github.com/settings/personal-access-tokens/new")
  url.searchParams.set("name", "Ready For Agent")
  url.searchParams.set(
    "description",
    `Ready For Agent token for ${repository.githubOwner}/${repository.githubRepo}`,
  )
  url.searchParams.set("target_name", repository.githubOwner)
  url.searchParams.set("expires_in", "90")
  url.searchParams.set("issues", "read")
  return url.toString()
}

const repositoryCredential = (
  repository: Repository,
  existingToken: string | null,
) => ({
  repositoryId: repository.id,
  configured: existingToken !== null,
  githubTokenSecretName: existingToken ?? githubTokenSecretName(repository),
  githubTokenCreationUrl: githubTokenCreationUrl(repository),
})

const toGraphQLError = (error: unknown): GraphQLError => {
  if (error instanceof IssueNotFoundError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} was not found in repository ${error.repositoryId}`,
      { extensions: { code: "ISSUE_NOT_FOUND" } },
    )
  }
  if (error instanceof IssueNotOpenError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} is ${error.state}, not OPEN`,
      { extensions: { code: "ISSUE_NOT_OPEN" } },
    )
  }
  if (error instanceof ParentIssueError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} has child issues and cannot be implemented directly`,
      { extensions: { code: "ISSUE_IS_PARENT" } },
    )
  }
  if (error instanceof IssueBlockedError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} is blocked by ${error.blockerCount} issue(s)`,
      { extensions: { code: "ISSUE_BLOCKED" } },
    )
  }
  if (error instanceof UnfinishedWorkItemExistsError) {
    return new GraphQLError(
      `Issue #${error.githubIssueNumber} already has an unfinished Work Item`,
      {
        extensions: {
          code: "UNFINISHED_WORK_ITEM_EXISTS",
          workItemId: error.workItemId,
        },
      },
    )
  }
  if (error instanceof WorkItemLifecycleDatabaseError) {
    return new GraphQLError(error.message, {
      extensions: { code: "WORK_ITEM_LIFECYCLE_DATABASE_ERROR" },
    })
  }
  if (error instanceof WorkItemNotFoundError) {
    return new GraphQLError(`Work Item not found: ${error.workItemId}`, {
      extensions: { code: "WORK_ITEM_NOT_FOUND" },
    })
  }
  if (error instanceof WorkItemTerminalError) {
    return new GraphQLError(
      `Work Item ${error.workItemId} is already ${error.state}`,
      { extensions: { code: "WORK_ITEM_TERMINAL" } },
    )
  }
  if (error instanceof ActiveStepRunExistsError) {
    return new GraphQLError(
      `Work Item ${error.workItemId} already has an active Step Run`,
      { extensions: { code: "ACTIVE_STEP_RUN_EXISTS" } },
    )
  }
  if (error instanceof RetryNotEligibleError) {
    return new GraphQLError(
      `Work Item ${error.workItemId} cannot be retried: ${error.reason}`,
      { extensions: { code: "RETRY_NOT_ELIGIBLE" } },
    )
  }
  if (error instanceof RepositoryCredentialError) {
    return new GraphQLError(error.message, {
      extensions: { code: "REPOSITORY_CREDENTIAL_ERROR" },
    })
  }
  if (error instanceof RepositoryAlreadyExistsError) {
    return new GraphQLError(
      `Repository ${error.githubOwner}/${error.githubRepo} already exists`,
      {
        extensions: { code: "REPOSITORY_ALREADY_EXISTS" },
      },
    )
  }
  if (error instanceof InvalidConfigInputError) {
    return new GraphQLError(error.message, {
      extensions: { code: "INVALID_CONFIG_INPUT", field: error.field },
    })
  }
  if (error instanceof LocalPathInUseError) {
    return new GraphQLError(`Local path already in use: ${error.localPath}`, {
      extensions: { code: "LOCAL_PATH_IN_USE" },
    })
  }
  if (error instanceof InvalidRepositoryInputError) {
    return new GraphQLError(error.message, {
      extensions: { code: "INVALID_REPOSITORY_INPUT", field: error.field },
    })
  }
  if (error instanceof RepositoryNotFoundError) {
    return new GraphQLError(`Repository not found: ${error.repositoryId}`, {
      extensions: { code: "REPOSITORY_NOT_FOUND" },
    })
  }
  if (error instanceof GitHubRepositoryUnavailableError) {
    return new GraphQLError(
      `GitHub repository is unavailable: ${error.owner}/${error.name}`,
      { extensions: { code: "GITHUB_REPOSITORY_UNAVAILABLE" } },
    )
  }
  if (error instanceof GitHubRequestError) {
    return new GraphQLError(error.message, {
      extensions: { code: "GITHUB_REQUEST_ERROR" },
    })
  }
  if (error instanceof ReconciliationMutationError) {
    return new GraphQLError(
      `Failed to ${error.operation} while refreshing repository`,
      {
        extensions: {
          code: "REPOSITORY_REFRESH_FAILED",
          operation: error.operation,
          ...(error.githubIssueNumber === undefined
            ? {}
            : { githubIssueNumber: error.githubIssueNumber }),
          progress: error.progress,
        },
      },
    )
  }
  if (error instanceof DatabaseError) {
    return new GraphQLError(error.message, {
      extensions: { code: "DATABASE_ERROR" },
    })
  }
  if (error instanceof EnqueueError) {
    return new GraphQLError(error.message, {
      extensions: { code: "ENQUEUE_ERROR" },
    })
  }
  if (error instanceof WorkItemNotFoundError) {
    return new GraphQLError(`Work Item not found: ${error.workItemId}`, {
      extensions: { code: "WORK_ITEM_NOT_FOUND" },
    })
  }
  if (error instanceof WorkItemLifecycleDatabaseError) {
    return new GraphQLError(error.message, {
      extensions: { code: "DATABASE_ERROR" },
    })
  }
  if (error instanceof ResetCleanupError) {
    return new GraphQLError(error.message, {
      extensions: { code: "RESET_CLEANUP_FAILED" },
    })
  }
  if (error instanceof GraphQLError) {
    return error
  }
  if (error instanceof Error) {
    return new GraphQLError(error.message, {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    })
  }
  return new GraphQLError("Unexpected error", {
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  })
}

const isSameOriginRequest = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  return origin === null || origin === new URL(request.url).origin
}

const toNativeResponse = (response: unknown): Response => {
  if (response instanceof Response) return response

  const compatibleResponse = response as Response
  return new Response(compatibleResponse.body, {
    headers: compatibleResponse.headers,
    status: compatibleResponse.status,
    statusText: compatibleResponse.statusText,
  })
}

export const createGraphqlApi = (
  runtime: GraphqlRuntime,
  options: { readonly opencodeCwd?: string } = {},
) => {
  const opencodeCwd = options.opencodeCwd ?? process.cwd()
  const tokenProvisioning = Effect.runSync(Semaphore.make(1))
  const yoga = createYoga({
    schema: createSchema({
      typeDefs,
      resolvers: {
        Query: {
          health: () => true,
          repositories: async () => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.listRepositories
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          repositoryCredentials: async () => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const repositories = yield* db.listRepositories
                  const keymaxxer = yield* KeymaxxerService
                  const tokenNames = yield* keymaxxer.findSecrets(
                    repositories.map((repository) => ({
                      provider: "github",
                      account: `${repository.githubOwner}/${repository.githubRepo}`,
                    })),
                  )
                  return repositories.map((repository, index) =>
                    repositoryCredential(repository, tokenNames[index] ?? null),
                  )
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          config: async () => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.getConfig
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          models: async () => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const opencode = yield* Opencode
                  return yield* opencode.listModels({
                    cwd: opencodeCwd,
                    timeout: "30 seconds",
                  })
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          issues: async (_parent: unknown, args: IssuesArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const issues = yield* db.listIssues(args.repositoryId)
                  return workIssueProjection(issues)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          workItems: async (_parent: unknown, args: WorkItemsArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return args.githubIssueNumber === undefined
                    ? yield* lifecycle.listWorkItemsForRepository(
                        args.repositoryId,
                      )
                    : yield* lifecycle.listWorkItemsForIssue(
                        args.repositoryId,
                        args.githubIssueNumber,
                      )
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
        },
        Issue: {
          githubCreatedAt: (issue: { githubCreatedAt: Date }) =>
            issue.githubCreatedAt.toISOString(),
        },
        Repository: {
          issuesReconciledAt: (repository: {
            issuesReconciledAt: Date | null
          }) => repository.issuesReconciledAt?.toISOString() ?? null,
        },
        WorkItem: {
          state: (workItem: { state: string }) => workItem.state.toUpperCase(),
          stateReadyAt: (workItem: { stateReadyAt: Date }) =>
            workItem.stateReadyAt.toISOString(),
          createdAt: (workItem: { createdAt: Date }) =>
            workItem.createdAt.toISOString(),
          updatedAt: (workItem: { updatedAt: Date }) =>
            workItem.updatedAt.toISOString(),
        },
        StepRun: {
          step: (stepRun: { step: string }) => stepRun.step.toUpperCase(),
          status: (stepRun: { status: string }) => stepRun.status.toUpperCase(),
          queuedAt: (stepRun: { queuedAt: Date }) =>
            stepRun.queuedAt.toISOString(),
          startedAt: (stepRun: { startedAt: Date | null }) =>
            stepRun.startedAt?.toISOString() ?? null,
          finishedAt: (stepRun: { finishedAt: Date | null }) =>
            stepRun.finishedAt?.toISOString() ?? null,
        },
        Subscription: {
          repositoriesChanged: {
            subscribe: async () =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(
                    db.repositoryChanges,
                  )
                }),
              ),
            resolve: () => true,
          },
          issuesChanged: {
            subscribe: async (_parent: unknown, args: RefreshRepositoryArgs) =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(
                    db.issueChanges.pipe(
                      Stream.filter(
                        (repositoryId) => repositoryId === args.repositoryId,
                      ),
                    ),
                  )
                }),
              ),
            resolve: () => true,
          },
          repositoryIssuesChanged: {
            subscribe: async () =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* Stream.toAsyncIterableEffect(db.issueChanges)
                }),
              ),
            resolve: (repositoryId: string) => repositoryId,
          },
        },
        Mutation: {
          updateConfig: async (_parent: unknown, args: UpdateConfigArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.updateConfig(args.input)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          addRepository: async (_parent: unknown, args: AddRepositoryArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  return yield* db.addRepository(args.input)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          addRepositoryGitHubToken: async (
            _parent: unknown,
            args: RepositoryCredentialArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                tokenProvisioning.withPermits(1)(
                  Effect.gen(function* () {
                    const db = yield* DbService
                    const repositories = yield* db.listRepositories
                    const repository = repositories.find(
                      ({ id }) => id === args.repositoryId,
                    )
                    if (repository === undefined) {
                      return yield* new RepositoryNotFoundError({
                        repositoryId: args.repositoryId,
                      })
                    }

                    const keymaxxer = yield* KeymaxxerService
                    const account = `${repository.githubOwner}/${repository.githubRepo}`
                    const existingToken = yield* keymaxxer.findSecret({
                      provider: "github",
                      account,
                    })
                    let tokenName = existingToken
                    if (tokenName === null) {
                      tokenName = githubTokenSecretName(repository)
                      if (yield* keymaxxer.hasSecret(tokenName)) {
                        return yield* new RepositoryCredentialError({
                          message: `Keymaxxer secret ${tokenName} already exists for another account`,
                        })
                      }
                      const added = yield* keymaxxer.addSecret({
                        name: tokenName,
                        provider: "github",
                        account,
                        environment: "prod",
                        access: "read-only",
                        description: `Fine-grained GitHub token for Ready for Agent on ${account}`,
                        tags: "ready-for-agent,harness,github",
                      })
                      if (!added) {
                        return yield* new RepositoryCredentialError({
                          message: "Keymaxxer GitHub token setup was cancelled",
                        })
                      }
                      tokenName = yield* keymaxxer.findSecret({
                        provider: "github",
                        account,
                      })
                      if (tokenName === null) {
                        return yield* new RepositoryCredentialError({
                          message:
                            "The saved Keymaxxer secret does not match this GitHub repository",
                        })
                      }
                    }
                    return repositoryCredential(repository, tokenName)
                  }),
                ),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          removeRepository: async (
            _parent: unknown,
            args: RemoveRepositoryArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  yield* db.removeRepository(args.repositoryId)
                  return args.repositoryId
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          resetWorkItem: async (_parent: unknown, args: ResetWorkItemArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.reset(args.workItemId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          refreshRepository: async (
            _parent: unknown,
            args: RefreshRepositoryArgs,
          ) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const db = yield* DbService
                  const repositories = yield* db.listRepositories
                  const repository = repositories.find(
                    ({ id }) => id === args.repositoryId,
                  )
                  if (repository === undefined) {
                    return yield* new RepositoryNotFoundError({
                      repositoryId: args.repositoryId,
                    })
                  }

                  const keymaxxer = yield* KeymaxxerService
                  const credential = yield* keymaxxer.findSecret({
                    provider: "github",
                    account: `${repository.githubOwner}/${repository.githubRepo}`,
                  })
                  if (credential === null) {
                    return yield* new RepositoryCredentialError({
                      message: `GitHub credential is not configured for ${repository.githubOwner}/${repository.githubRepo}`,
                    })
                  }

                  const queue = yield* QueueService
                  const jobId = yield* queue.enqueue(
                    JOBS_QUEUE,
                    {
                      _tag: "refresh-repository",
                      repositoryId: RepositoryId.make(repository.id),
                    },
                    { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
                  )
                  return {
                    id: jobId,
                    repositoryId: repository.id,
                  }
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          implementNow: async (_parent: unknown, args: ImplementNowArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.implementNow(
                    args.repositoryId,
                    args.githubIssueNumber,
                  )
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
          retryWorkItem: async (_parent: unknown, args: WorkItemArgs) => {
            const result = await runtime.runPromise(
              Effect.result(
                Effect.gen(function* () {
                  const lifecycle = yield* WorkItemLifecycle
                  return yield* lifecycle.retry(args.workItemId)
                }),
              ),
            )
            if (Result.isFailure(result)) {
              throw toGraphQLError(result.failure)
            }
            return result.success
          },
        },
      },
    }),
    batching: true,
    cors: false,
    fetchAPI: { Response },
    graphqlEndpoint: "/graphql",
    graphiql: true,
  })

  return {
    fetch: async (request: Request): Promise<Response> => {
      if (!isSameOriginRequest(request)) {
        return new Response("Cross-origin GraphQL requests are not allowed", {
          status: 403,
        })
      }
      return toNativeResponse(await yoga.fetch(request))
    },
  }
}

export type GraphqlApi = ReturnType<typeof createGraphqlApi>
