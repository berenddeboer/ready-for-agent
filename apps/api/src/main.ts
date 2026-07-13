import { createSchema, createYoga } from "graphql-yoga"
import { typeDefs } from "@ready-for-agent/graphql-schema"

const port = Number(process.env.PORT ?? 3001)

const yoga = createYoga({
  schema: createSchema({
    typeDefs,
    resolvers: {
      Query: {
        health: () => true,
      },
      Mutation: {
        addRepository: (
          _parent,
          args: {
            input: {
              githubOwner: string
              githubRepo: string
              localPath: string
              isBare: boolean
            }
          },
        ) => ({
          id: "stub-repository-id",
          githubOwner: args.input.githubOwner,
          githubRepo: args.input.githubRepo,
          localPath: args.input.localPath,
          isBare: args.input.isBare,
          paused: true,
        }),
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
