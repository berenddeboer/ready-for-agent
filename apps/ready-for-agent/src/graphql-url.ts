const defaultGraphqlUrl = "http://127.0.0.1:4200/graphql"

export const resolveGraphqlUrl = (): string =>
  process.env.READY_FOR_AGENT_GRAPHQL_URL ?? defaultGraphqlUrl
