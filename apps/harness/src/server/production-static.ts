import { resolve, sep } from "node:path"
import type { ApplicationRequestContext } from "../application-request-context.js"

export type StartHandler = {
  fetch: (
    request: Request,
    options: { context: ApplicationRequestContext },
  ) => Response | Promise<Response>
}

export type EmbeddedClientAssets = Readonly<Record<string, string>>

const contentTypeForPathname = (pathname: string): string | undefined => {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8"
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8"
  }
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8"
  if (pathname.endsWith(".svg")) return "image/svg+xml"
  if (pathname.endsWith(".json")) return "application/json"
  if (pathname.endsWith(".png")) return "image/png"
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg"
  }
  if (pathname.endsWith(".woff2")) return "font/woff2"
  if (pathname.endsWith(".woff")) return "font/woff"
  if (pathname.endsWith(".map")) return "application/json"
  return undefined
}

export const serveStaticAssetFromDirectory = async (
  request: Request,
  clientDirectory: string,
): Promise<Response | undefined> => {
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

export const serveStaticAssetFromEmbed = async (
  request: Request,
  assets: EmbeddedClientAssets,
): Promise<Response | undefined> => {
  const url = new URL(request.url)
  if (url.pathname === "/" || url.pathname.endsWith("/")) return undefined

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }

  const embeddedPath = assets[pathname]
  if (embeddedPath === undefined) return undefined

  const file = Bun.file(embeddedPath)
  if (!(await file.exists())) return undefined

  const headers: Record<string, string> = {
    "cache-control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  }
  const contentType = contentTypeForPathname(pathname)
  if (contentType !== undefined) {
    headers["content-type"] = contentType
  }

  return new Response(file, { headers })
}
