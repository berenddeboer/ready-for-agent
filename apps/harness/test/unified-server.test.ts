import { Route } from "../src/routes/graphql.ts"
import { expect, test } from "bun:test"

test("routes /graphql through the injected GraphQL handler", async () => {
  let delegatedUrl: string | undefined
  const foreignResponse = {
    body: JSON.stringify({ data: { health: true } }),
    headers: new Headers({ "content-type": "application/json" }),
    status: 200,
    statusText: "OK",
  } as unknown as Response

  const request = new Request("http://127.0.0.1:6056/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ health }" }),
  })
  const context = {
    graphqlApi: {
      fetch: (incoming: Request) => {
        delegatedUrl = incoming.url
        return foreignResponse
      },
    },
  }

  const handlers = Route.options.server?.handlers
  expect(handlers).toBeDefined()
  if (handlers === undefined || typeof handlers === "function") {
    throw new Error("expected GraphQL route object handlers")
  }
  const post = handlers.POST
  expect(post).toBeTypeOf("function")
  if (post === undefined) {
    throw new Error("expected GraphQL POST handler")
  }
  const response = await post({ request, context } as never)
  if (!(response instanceof Response)) {
    throw new Error("expected Response from GraphQL POST handler")
  }

  expect(response.status).toBe(200)
  expect(delegatedUrl).toBe("http://127.0.0.1:6056/graphql")
  expect(await response.json()).toEqual({ data: { health: true } })
})
