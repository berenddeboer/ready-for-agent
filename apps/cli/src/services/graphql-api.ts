import { Context, Effect, Layer, Schema } from "effect"
import { createClient } from "@ready-for-agent/graphql-client"
import type { LocalRepository } from "../domain.ts"
import { resolveGraphqlUrl } from "../graphql-url.ts"

class GraphqlRequestFailed extends Schema.TaggedErrorClass<GraphqlRequestFailed>()(
  "GraphqlRequestFailed",
  { message: Schema.String },
) {}

export type RepositorySummary = {
  readonly id: string
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: boolean
}

export type RepositoryCredentialSummary = {
  readonly repositoryId: string
  readonly configured: boolean
  readonly githubTokenSecretName: string
  readonly githubTokenCreationUrl: string
}

export class GraphqlApi extends Context.Service<
  GraphqlApi,
  {
    readonly addRepository: (
      repository: LocalRepository,
    ) => Effect.Effect<RepositorySummary, GraphqlRequestFailed>
    readonly listRepositories: Effect.Effect<
      readonly RepositorySummary[],
      GraphqlRequestFailed
    >
    readonly removeRepositoryGitHubToken: (
      repositoryId: string,
    ) => Effect.Effect<RepositoryCredentialSummary, GraphqlRequestFailed>
  }
>()("@ready-for-agent/cli/GraphqlApi") {
  static readonly layer = Layer.succeed(GraphqlApi, {
    addRepository: (repository) =>
      Effect.tryPromise({
        try: async () => {
          const client = createClient({
            url: resolveGraphqlUrl(),
          })
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
            message:
              cause instanceof Error ? cause.message : "GraphQL request failed",
          }),
      }),
    listRepositories: Effect.tryPromise({
      try: async () => {
        const client = createClient({
          url: resolveGraphqlUrl(),
        })
        const result = await client.query({
          repositories: {
            id: true,
            githubOwner: true,
            githubRepo: true,
            localPath: true,
            isBare: true,
            paused: true,
          },
        })
        return result.repositories ?? []
      },
      catch: (cause) =>
        new GraphqlRequestFailed({
          message:
            cause instanceof Error ? cause.message : "GraphQL request failed",
        }),
    }),
    removeRepositoryGitHubToken: (repositoryId) =>
      Effect.tryPromise({
        try: async () => {
          const client = createClient({
            url: resolveGraphqlUrl(),
          })
          const result = await client.mutation({
            removeRepositoryGitHubToken: {
              __args: { repositoryId },
              repositoryId: true,
              configured: true,
              githubTokenSecretName: true,
              githubTokenCreationUrl: true,
            },
          })
          const removed = result.removeRepositoryGitHubToken
          if (!removed) {
            throw new Error("removeRepositoryGitHubToken returned null")
          }
          return removed
        },
        catch: (cause) =>
          new GraphqlRequestFailed({
            message:
              cause instanceof Error ? cause.message : "GraphQL request failed",
          }),
      }),
  })
}
