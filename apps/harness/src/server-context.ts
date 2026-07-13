import type { GraphqlApi } from "@ready-for-agent/graphql-api"

export interface ApplicationRequestContext {
  readonly graphqlApi: GraphqlApi
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: ApplicationRequestContext
    }
  }
}
