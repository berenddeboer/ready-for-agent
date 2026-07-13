import handler, { createServerEntry } from "@tanstack/react-start/server-entry"
import type { Application } from "./server/application.server.js"
import type { ApplicationRequestContext } from "./server-context.js"

let applicationPromise: Promise<Application> | undefined

const getApplication = () => {
  applicationPromise ??= import("./server/application.server.js").then(
    ({ createApplication }) => createApplication(),
  )
  return applicationPromise
}

const prerenderContext: ApplicationRequestContext = {
  graphqlApi: {
    fetch: async () =>
      new Response("GraphQL is unavailable while prerendering", {
        status: 503,
      }),
  },
}

export default createServerEntry({
  async fetch(request, options) {
    if (options?.context !== undefined) {
      return handler.fetch(request, options)
    }

    const context =
      process.env.TSS_PRERENDERING === "true"
        ? prerenderContext
        : (await getApplication()).context

    return handler.fetch(request, { ...options, context })
  },
})

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    const currentApplication = applicationPromise
    applicationPromise = undefined
    if (currentApplication !== undefined) {
      await (await currentApplication).dispose()
    }
  })
}
