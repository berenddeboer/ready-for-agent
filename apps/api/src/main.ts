import { Effect, Either, Layer, ManagedRuntime } from "effect"
import { GraphQLError } from "graphql"
import { createSchema, createYoga } from "graphql-yoga"
import { DatabaseLive } from "@ready-for-agent/db"
import {
  DatabaseError,
  DbService,
  DbServiceLive,
  InvalidRepositoryInputError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
} from "@ready-for-agent/db-service"
import { typeDefs } from "@ready-for-agent/graphql-schema"

const port = Number(process.env.PORT ?? 3001)

const AppLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseLive))
const runtime = ManagedRuntime.make(AppLayer)

type AddRepositoryArgs = {
  input: {
    githubOwner: string
    githubRepo: string
    localPath: string
    isBare: boolean
  }
}

const toGraphQLError = (error: unknown): GraphQLError => {
  if (error instanceof RepositoryAlreadyExistsError) {
    return new GraphQLError(
      `Repository ${error.githubOwner}/${error.githubRepo} already exists`,
      {
        extensions: { code: "REPOSITORY_ALREADY_EXISTS" },
      },
    )
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

const yoga = createYoga({
  schema: createSchema({
    typeDefs,
    resolvers: {
      Query: {
        health: () => true,
      },
      Mutation: {
        addRepository: async (_parent: unknown, args: AddRepositoryArgs) => {
          const result = await runtime.runPromise(
            Effect.either(
              Effect.gen(function* () {
                const db = yield* DbService
                return yield* db.addRepository(args.input)
              }),
            ),
          )
          if (Either.isLeft(result)) {
            throw toGraphQLError(result.left)
          }
          return result.right
        },
      },
    },
  }),
  graphqlEndpoint: "/graphql",
  graphiql: true,
})

const server = Bun.serve({
  port,
  fetch: yoga,
})

console.info(
  `GraphQL API listening on ${new URL(
    yoga.graphqlEndpoint,
    `http://${server.hostname}:${server.port}`,
  )}`,
)
