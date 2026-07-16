import { relative, sep } from "node:path"
import type { Plugin, ViteDevServer } from "vite"
import { disposeDevelopmentApplication } from "./development-application.js"

const restartDelayMs = 50

export const isBackendRuntimeSource = (file: string, workspaceRoot: string) => {
  const relativeFile = relative(workspaceRoot, file).split(sep).join("/")
  if (relativeFile.startsWith("../")) return false

  if (relativeFile === "apps/harness/src/server.ts") return true
  if (relativeFile.startsWith("apps/harness/src/server/")) return true
  if (!relativeFile.startsWith("packages/")) return false

  const [, packageName, sourceDirectory] = relativeFile.split("/")
  return sourceDirectory === "src" && packageName !== "graphql-client"
}

export const backendRuntimeRestart = (
  workspaceRoot: string,
  delay = restartDelayMs,
): Plugin => {
  let server: ViteDevServer | undefined
  let restartTimeout: ReturnType<typeof setTimeout> | undefined
  let restarting = false

  const scheduleRestart = () => {
    if (server === undefined) return
    if (restartTimeout !== undefined) clearTimeout(restartTimeout)

    restartTimeout = setTimeout(() => {
      restartTimeout = undefined
      restarting = true
      void disposeDevelopmentApplication()
        .then(() => server?.restart())
        .catch((error: unknown) => {
          server?.config.logger.error(
            `Backend runtime restart failed: ${String(error)}`,
          )
        })
        .finally(() => {
          restarting = false
        })
    }, delay)
  }

  return {
    name: "ready-for-agent-backend-runtime-restart",
    apply: "serve",
    configureServer(viteServer) {
      server = viteServer
      viteServer.middlewares.use((_request, response, next) => {
        if (!restarting) {
          next()
          return
        }

        response.statusCode = 503
        response.setHeader("Retry-After", "1")
        response.end("Server runtime is restarting")
      })
    },
    hotUpdate({ file }) {
      if (isBackendRuntimeSource(file, workspaceRoot)) scheduleRestart()
    },
    async closeBundle() {
      if (restartTimeout !== undefined) clearTimeout(restartTimeout)
      restartTimeout = undefined
      await disposeDevelopmentApplication()
    },
  }
}
