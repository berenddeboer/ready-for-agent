import { expect, test } from "bun:test"

test("routes /graphql through the injected GraphQL handler", async () => {
  const serverEntryPath = "../dist/server/server.js"
  const serverEntry = (await import(serverEntryPath)) as {
    default: {
      fetch: (
        request: Request,
        options: {
          context: {
            graphqlApi: {
              fetch: (request: Request) => Response | Promise<Response>
            }
          }
        },
      ) => Response | Promise<Response>
    }
  }
  let delegatedUrl: string | undefined
  const foreignResponse = {
    body: JSON.stringify({ data: { health: true } }),
    headers: new Headers({ "content-type": "application/json" }),
    status: 200,
    statusText: "OK",
  } as unknown as Response

  const response = await serverEntry.default.fetch(
    new Request("http://127.0.0.1:4200/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ health }" }),
    }),
    {
      context: {
        graphqlApi: {
          fetch: (request) => {
            delegatedUrl = request.url
            return foreignResponse
          },
        },
      },
    },
  )

  expect(response.status).toBe(200)
  expect(delegatedUrl).toBe("http://127.0.0.1:4200/graphql")
  expect(await response.json()).toEqual({ data: { health: true } })
})
