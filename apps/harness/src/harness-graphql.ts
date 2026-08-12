/**
 * Browser GraphQL stays on the root-relative path. SSR `fetch` needs an
 * absolute origin or it rejects the URL and dehydrates queries as failed.
 */

import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { createClient } from "@ready-for-agent/graphql-client"

export const GRAPHQL_PATH = "/graphql"

export const toFetchableGraphqlUrl = (input: {
  readonly url: string
  readonly base: string
}): string => new URL(input.url, input.base).href

const resolveRelativeGraphqlUrl = createIsomorphicFn()
  .server((url: string) => {
    if (typeof document !== "undefined") {
      return url
    }
    try {
      return toFetchableGraphqlUrl({ url, base: getRequest().url })
    } catch {
      return toFetchableGraphqlUrl({
        url,
        base: `http://127.0.0.1:${process.env.PORT ?? "6056"}/`,
      })
    }
  })
  .client((url: string) => url)

export const resolveGraphqlFetchUrl = (url: string): string => {
  try {
    return new URL(url).href
  } catch {
    return resolveRelativeGraphqlUrl(url)
  }
}

const fetchGraphql = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  if (typeof input === "string") {
    return fetch(resolveGraphqlFetchUrl(input), init)
  }
  return fetch(input, init)
}

export const createHarnessGraphqlClient = (options?: {
  readonly batch?: boolean
}) =>
  createClient({
    url: GRAPHQL_PATH,
    ...(options?.batch === undefined ? {} : { batch: options.batch }),
    fetch: fetchGraphql,
  })
