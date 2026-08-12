import { Context, Effect, Layer, Runtime, Schema } from "effect"
import { createClient } from "@ready-for-agent/graphql-client"
import type { IntakeCandidateAction } from "../cli-json.ts"
import type { LocalRepository, RepositorySummary } from "../domain.ts"
import { describeGraphqlFailure } from "../graphql-error.ts"
import { ApplicationConfig } from "./application-config.ts"

/**
 * Expected GraphQL operator failures. Marked as already reported so
 * `BunRuntime.runMain` does not pretty-print a multi-frame stack after the
 * CLI writes the versioned JSON error once (harness-down and similar).
 * `code` is the Harness `extensions.code` or a CLI-owned transport code.
 */
export class GraphqlRequestFailed extends Schema.TaggedErrorClass<GraphqlRequestFailed>()(
  "GraphqlRequestFailed",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false
}

export type ConfiguredRepository = {
  readonly id: string
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}

export type IntakeCandidatesResult = {
  readonly repository: {
    readonly id: string
    readonly forge: string
    readonly forgeHost: string
    readonly projectPath: string
    readonly issuesReconciledAt: string | null
  }
  readonly candidates: readonly {
    readonly issueNumber: number
    readonly title: string
    readonly url: string
    readonly action: IntakeCandidateAction
  }[]
}

export class GraphqlApi extends Context.Service<
  GraphqlApi,
  {
    readonly addRepository: (
      repository: LocalRepository,
    ) => Effect.Effect<RepositorySummary, GraphqlRequestFailed>
    readonly listRepositories: Effect.Effect<
      readonly ConfiguredRepository[],
      GraphqlRequestFailed
    >
    readonly intakeCandidates: (
      repositoryId: string,
    ) => Effect.Effect<IntakeCandidatesResult, GraphqlRequestFailed>
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
          catch: (cause) => {
            const failure = describeGraphqlFailure(cause, {
              graphqlUrl: config.graphqlUrl,
            })
            return new GraphqlRequestFailed({
              code: failure.code,
              message: failure.message,
            })
          },
        })
      })

      const listRepositories = Effect.tryPromise({
        try: async () => {
          const result = await client.query({
            repositories: {
              id: true,
              forge: true,
              forgeHost: true,
              projectPath: true,
            },
          })
          return result.repositories ?? []
        },
        catch: (cause) => {
          const failure = describeGraphqlFailure(cause, {
            graphqlUrl: config.graphqlUrl,
          })
          return new GraphqlRequestFailed({
            code: failure.code,
            message: failure.message,
          })
        },
      }).pipe(Effect.withSpan("GraphqlApi.listRepositories"))

      const intakeCandidates = Effect.fn("GraphqlApi.intakeCandidates")(
        function* (repositoryId: string) {
          return yield* Effect.tryPromise({
            try: async () => {
              const result = await client.query({
                intakeCandidates: {
                  __args: { repositoryId },
                  repository: {
                    id: true,
                    forge: true,
                    forgeHost: true,
                    projectPath: true,
                    issuesReconciledAt: true,
                  },
                  candidates: {
                    issueNumber: true,
                    title: true,
                    url: true,
                    action: true,
                  },
                },
              })
              const payload = result.intakeCandidates
              if (!payload) {
                throw new Error("intakeCandidates returned null")
              }
              return {
                repository: {
                  id: payload.repository.id,
                  forge: payload.repository.forge,
                  forgeHost: payload.repository.forgeHost,
                  projectPath: payload.repository.projectPath,
                  issuesReconciledAt:
                    payload.repository.issuesReconciledAt ?? null,
                },
                candidates: payload.candidates.map(
                  (candidate: {
                    readonly issueNumber: number
                    readonly title: string
                    readonly url: string
                    readonly action: IntakeCandidateAction
                  }) => ({
                    issueNumber: candidate.issueNumber,
                    title: candidate.title,
                    url: candidate.url,
                    action: candidate.action,
                  }),
                ),
              }
            },
            catch: (cause) => {
              const failure = describeGraphqlFailure(cause, {
                graphqlUrl: config.graphqlUrl,
              })
              return new GraphqlRequestFailed({
                code: failure.code,
                message: failure.message,
              })
            },
          })
        },
      )

      return { addRepository, listRepositories, intakeCandidates }
    }),
  )
}
