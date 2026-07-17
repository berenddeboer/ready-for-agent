import { spawn } from "node:child_process"
import { resolve, sep } from "node:path"
import { createApplication } from "./src/server/application.server.js"
import type { ApplicationRequestContext } from "./src/server-context.js"

const hostname = "127.0.0.1"
const port = Number(process.env.PORT ?? 4200)
const clientDirectory = resolve(import.meta.dir, "dist/client")
const serverEntryPath = "./dist/server/server.js"

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port")
}

const shouldOpenBrowser = () => {
  const raw = process.env.NO_BROWSER?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return true
  }
  return false
}

const openDefaultBrowser = (url: string) => {
  const launch =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] }
  try {
    spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
    }).unref()
  } catch {
    // Browser open is best-effort; start still succeeds.
  }
}

type StartHandler = {
  fetch: (
    request: Request,
    options: { context: ApplicationRequestContext },
  ) => Response | Promise<Response>
}

const serveStaticAsset = async (request: Request) => {
  const url = new URL(request.url)
  if (url.pathname === "/" || url.pathname.endsWith("/")) return undefined

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }

  const filePath = resolve(clientDirectory, `.${pathname}`)
  if (!filePath.startsWith(`${clientDirectory}${sep}`)) return undefined

  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined

  return new Response(file, {
    headers: {
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  })
}

const application = await createApplication()

let handler: StartHandler
try {
  const serverModule = (await import(serverEntryPath)) as {
    default: StartHandler
  }
  handler = serverModule.default
} catch (error) {
  await application.dispose()
  throw error
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    if (new URL(request.url).hostname !== hostname) {
      return new Response("Invalid Host", { status: 421 })
    }

    const assetResponse = await serveStaticAsset(request)
    return (
      assetResponse ?? handler.fetch(request, { context: application.context })
    )
  },
})

const listenUrl = `http://${hostname}:${server.port}/`
console.info(`Ready for Agent listening on ${listenUrl.slice(0, -1)}`)
if (shouldOpenBrowser()) {
  openDefaultBrowser(listenUrl)
}

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await server.stop(true)
  await application.dispose()
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
