import { startProductionLifecycle } from "../../harness/src/server/production-lifecycle.ts"
import { createEmbeddedSpaStartHandler } from "../../harness/src/server/production-static.ts"
import {
  embeddedClientAssets,
  embeddedShellHtmlPath,
} from "./generated/client-assets.ts"

export const bootStandaloneProduction = async (input: {
  readonly noOpen: boolean
}): Promise<void> => {
  const argv = [
    ...process.argv,
    ...(input.noOpen ? (["--no-open"] as const) : []),
  ]

  await startProductionLifecycle({
    environment: process.env,
    argv,
    embeddedClientAssets,
    loadStartHandler: async () =>
      createEmbeddedSpaStartHandler({
        shellHtmlPath: embeddedShellHtmlPath,
      }),
    waitForShutdown: true,
  })
}
