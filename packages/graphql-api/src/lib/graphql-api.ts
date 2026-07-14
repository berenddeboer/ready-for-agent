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
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "@ready-for-agent/github-service"
import { typeDefs } from "@ready-for-agent/graphql-schema"
import {
  IssueReconciler,
  ReconciliationMutationError,
} from "@ready-for-agent/issue-reconciler"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"

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
  DbService | IssueReconciler | KeymaxxerService | Opencode,
  unknown
>

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

                  const reconciler = yield* IssueReconciler
                  return yield* reconciler.reconcile(repository)
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
