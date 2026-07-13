import { Effect, type ManagedRuntime, Result } from "effect"
import { GraphQLError } from "graphql"
import { createSchema, createYoga } from "graphql-yoga"
import {
  DatabaseError,
  DbService,
  InvalidConfigInputError,
  InvalidRepositoryInputError,
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

type UpdateConfigArgs = {
  input: {
    defaultModel: string
    defaultVariant: string
  }
}

export type GraphqlRuntime = ManagedRuntime.ManagedRuntime<
  DbService | IssueReconciler,
  unknown
>

const toGraphQLError = (error: unknown): GraphQLError => {
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

export const createGraphqlApi = (runtime: GraphqlRuntime) => {
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
