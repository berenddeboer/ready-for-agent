import { Context, Effect, Layer, Runtime, Schema } from "effect"
import { createClient } from "@ready-for-agent/graphql-client"
import type { LocalRepository, RepositorySummary } from "../domain.ts"
import { formatGraphqlRequestFailure } from "../graphql-error.ts"
import { ApplicationConfig } from "./application-config.ts"

/**
 * Expected GraphQL operator failures. Marked as already reported so
 * `BunRuntime.runMain` does not pretty-print a multi-frame stack after the
 * CLI prints the user-facing `message` once (harness-down and similar).
 */
export class GraphqlRequestFailed extends Schema.TaggedErrorClass<GraphqlRequestFailed>()(
  "GraphqlRequestFailed",
  { message: Schema.String },
) {
  override readonly [Runtime.errorReported] = false
}

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
                    forge: repository.forge,
                    forgeHost: repository.forgeHost,
                    projectPath: repository.projectPath,
                    localPath: repository.localPath,
                    isBare: repository.isBare,
                  },
                },
                id: true,
                forge: true,
                forgeHost: true,
                projectPath: true,
                localPath: true,
                isBare: true,
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
              message: formatGraphqlRequestFailure(cause, {
                graphqlUrl: config.graphqlUrl,
              }),
            }),
        })
      })

      return { addRepository }
    }),
  )
}
