import { startProductionLifecycle } from "../../harness/src/server/production-lifecycle.ts"
import {
  embeddedClientAssets,
  embeddedShellHtmlPath,
} from "./generated/client-assets.ts"

const normalizeGraphqlResponse = (response: unknown): Response => {
  if (response instanceof Response) return response
  const compatible = response as Response
  return new Response(compatible.body, {
    headers: compatible.headers,
    status: compatible.status,
    statusText: compatible.statusText,
  })
}

/**
 * Production SPA handler for the compiled binary: GraphQL via application
 * context, shell HTML otherwise (Vite SSR bundle is not required at runtime).
 */
const createEmbeddedSpaStartHandler = (input: {
  readonly shellHtmlPath: string
}) => ({
  fetch: async (
    request: Request,
    options: {
      context: {
        graphqlApi: {
          fetch: (request: Request) => Response | Promise<Response>
        }
      }
    },
  ) => {
    const url = new URL(request.url)
    if (url.pathname === "/graphql") {
      return normalizeGraphqlResponse(
        await options.context.graphqlApi.fetch(request),
      )
    }

    const shell = Bun.file(input.shellHtmlPath)
    return new Response(shell, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    })
  },
})

export const bootStandaloneProduction = async (input: {
  readonly noOpen: boolean
  readonly databasePath: string
  readonly browserEnv: {
    readonly NO_BROWSER?: string | undefined
    readonly PORT?: string | undefined
  }
}): Promise<void> => {
  const argv = [
    ...process.argv,
    ...(input.noOpen ? (["--no-open"] as const) : []),
  ]

  // The production lifecycle is Promise-based host code. Keep its ambient
  // environment read here and pass an immutable override instead of mutating it.
  await startProductionLifecycle({
    environment: {
      ...process.env,
      ...input.browserEnv,
      SQLITE_DATABASE_PATH: input.databasePath,
    },
    argv,
    embeddedClientAssets,
    loadStartHandler: async () =>
      createEmbeddedSpaStartHandler({
        shellHtmlPath: embeddedShellHtmlPath,
      }),
    waitForShutdown: true,
  })
}
