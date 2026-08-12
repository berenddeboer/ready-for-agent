import { requestHandler } from "@tanstack/react-start/server"
import {
  GRAPHQL_PATH,
  resolveGraphqlFetchUrl,
  toFetchableGraphqlUrl,
} from "../src/harness-graphql.ts"
import { repositoriesQuery } from "../src/repositories-query.ts"
import { describe, expect, test } from "bun:test"

const emptyRepositoriesPayload = {
  repositories: [],
  repositoryCredentials: [],
}

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

describe("Harness GraphQL URL", () => {
  test("joins the GraphQL path onto an absolute origin", () => {
    expect(
      toFetchableGraphqlUrl({
        url: GRAPHQL_PATH,
        base: "http://127.0.0.1:6056/repos",
      }),
    ).toBe("http://127.0.0.1:6056/graphql")
    expect(
      toFetchableGraphqlUrl({
        url: GRAPHQL_PATH,
        base: "http://192.168.1.10:4300/",
      }),
    ).toBe("http://192.168.1.10:4300/graphql")
  })

  test("server fallback without a request is still an absolute GraphQL URL", () => {
    const url = resolveGraphqlFetchUrl(GRAPHQL_PATH)
    expect(() => new URL(url)).not.toThrow()
    expect(new URL(url).pathname).toBe("/graphql")
  })
})

describe("Configured Repositories GraphQL during SSR", () => {
  test("does not fail the repositories query with an invalid URL", async () => {
    const fetchedUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      fetchedUrls.push(url)
      expect(() => new URL(url)).not.toThrow()
      return new Response(JSON.stringify({ data: emptyRepositoriesPayload }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    }) as typeof fetch

    try {
      const handler = requestHandler(async () => {
        const repositories = await repositoriesQuery.queryFn()
        return Response.json(repositories)
      })
      const response = await handler(
        new Request("http://127.0.0.1:6056/repos"),
        {},
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchedUrls).toEqual(["http://127.0.0.1:6056/graphql"])
  })

  test("uses the incoming request origin, not a hard-coded loopback default", async () => {
    const fetchedUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(requestUrl(input))
      return new Response(JSON.stringify({ data: emptyRepositoriesPayload }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    }) as typeof fetch

    try {
      const handler = requestHandler(async () => {
        await repositoriesQuery.queryFn()
        return new Response("ok")
      })
      await handler(new Request("http://192.168.1.10:4300/"), {})
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchedUrls).toEqual(["http://192.168.1.10:4300/graphql"])
  })
})
