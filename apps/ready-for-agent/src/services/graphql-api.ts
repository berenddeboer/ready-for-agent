import { Context, Effect, Layer, Schema } from "effect"
import { createClient } from "@ready-for-agent/graphql-client"
import type { LocalRepository, RepositorySummary } from "../domain.ts"
import { formatGraphqlRequestFailure } from "../graphql-error.ts"
import { ApplicationConfig } from "./application-config.ts"

export class GraphqlRequestFailed extends Schema.TaggedErrorClass<GraphqlRequestFailed>()(
  "GraphqlRequestFailed",
  { message: Schema.String },
) {}

export class GraphqlApi extends Context.Service<
  GraphqlApi,
  {
    readonly addRepository: (
      repository: LocalRepository,
    ) => Effect.Effect<RepositorySummary, GraphqlRequestFailed>
  }
>()("ready-for-agent/GraphqlApi") {
  static readonly layer = Layer.effect(
    GraphqlApi,
    Effect.gen(function* () {
      const config = yield* ApplicationConfig
      const client = createClient({ url: config.graphqlUrl })

      const addRepository = Effect.fn("GraphqlApi.addRepository")(function* (
        repository: LocalRepository,
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await client.mutation({
              addRepository: {
                __args: {
                  input: {
                    githubOwner: repository.githubOwner,
                    githubRepo: repository.githubRepo,
                    localPath: repository.localPath,
                    isBare: repository.isBare,
                  },
                },
                id: true,
                githubOwner: true,
                githubRepo: true,
                localPath: true,
                isBare: true,
                paused: true,
              },
            })
            const added = result.addRepository
            if (!added) {
              throw new Error("addRepository returned null")
            }
            return added
          },
          catch: (cause) =>
            new GraphqlRequestFailed({
              message: formatGraphqlRequestFailure(cause),
            }),
        })
      })

      return { addRepository }
    }),
  )
}
