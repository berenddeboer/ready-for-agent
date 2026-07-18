import type { GraphqlApi } from "@ready-for-agent/graphql-api"

export interface ApplicationRequestContext {
  readonly graphqlApi: GraphqlApi
}
