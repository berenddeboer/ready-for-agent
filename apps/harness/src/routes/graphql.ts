import { createFileRoute } from "@tanstack/react-router"
import "../server-context.js"

const handleGraphqlRequest = async ({
  request,
  context,
}: {
  request: Request
  context: {
    graphqlApi: {
      fetch: (request: Request) => Response | Promise<Response>
    }
  }
}) => {
  const response: unknown = await context.graphqlApi.fetch(request)
  if (response instanceof Response) return response

  const compatibleResponse = response as Response
  return new Response(compatibleResponse.body, {
    headers: compatibleResponse.headers,
    status: compatibleResponse.status,
    statusText: compatibleResponse.statusText,
  })
}

export const Route = createFileRoute("/graphql")({
  server: {
    handlers: {
      GET: handleGraphqlRequest,
      POST: handleGraphqlRequest,
    },
  },
})
