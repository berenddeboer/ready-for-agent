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

  const request = new Request("http://127.0.0.1:4200/graphql", {
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

  const post = Route.options.server?.handlers?.POST
  expect(post).toBeTypeOf("function")
  const response = await post!({ request, context } as never)

  expect(response.status).toBe(200)
  expect(delegatedUrl).toBe("http://127.0.0.1:4200/graphql")
  expect(await response.json()).toEqual({ data: { health: true } })
})
