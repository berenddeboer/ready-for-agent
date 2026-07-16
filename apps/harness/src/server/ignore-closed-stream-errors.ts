export const isBenignClosedStreamError = (error: unknown): boolean => {
  if (!(error instanceof TypeError)) return false
  if ((error as { code?: string }).code !== "ERR_INVALID_STATE") return false
  if (!error.message.includes("ReadableStream is already closed")) return false

  const stack = error.stack ?? ""
  return (
    stack.includes(
      "at ReadableByteStreamController.close (node:internal/webstreams/readablestream:",
    ) && stack.includes("at node:internal/deps/undici/undici:")
  )
}

const isAbortLike = (error: object): boolean => {
  const name = (error as { name?: string }).name
  const message = String((error as { message?: unknown }).message ?? "")
  if (name !== "AbortError") return false
  return (
    message === "" ||
    message.includes("This operation was aborted") ||
    message.includes("The operation was aborted")
  )
}

const hasSrvxDisconnectStack = (error: object): boolean => {
  const stack = String((error as { stack?: unknown }).stack ?? "")
  return (
    stack.includes("srvx/dist/adapters/node.mjs") ||
    stack.includes("srvx/dist/adapters/node.js")
  )
}

/**
 * Client disconnects (tab close, navigation, HMR, cancelled SSE) make srvx abort
 * the request. H3 then logs that as an unhandled HTTPError with status 500.
 */
export const isBenignRequestAbortError = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") return false
  if (isAbortLike(error)) return hasSrvxDisconnectStack(error)

  const cause = (error as { cause?: unknown }).cause
  if (cause === null || typeof cause !== "object" || !isAbortLike(cause)) {
    return false
  }
  return (
    (error as { unhandled?: unknown }).unhandled === true &&
    (hasSrvxDisconnectStack(error) || hasSrvxDisconnectStack(cause))
  )
}

const isBenignDevServerError = (error: unknown): boolean =>
  isBenignClosedStreamError(error) || isBenignRequestAbortError(error)

/**
 * Suppress known-benign Node/Vite/srvx teardown noise so client disconnects and
 * undici stream races do not flood the dev console or kill the process.
 */
export const ignoreClosedStreamErrors = (): void => {
  const key = Symbol.for("ready-for-agent.ignoreClosedStreamErrors")
  const state = globalThis as typeof globalThis & { [key]?: true }
  if (state[key]) return
  state[key] = true

  const originalConsoleError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    if (args.length === 1 && isBenignDevServerError(args[0])) return
    originalConsoleError(...args)
  }

  process.on("uncaughtException", (error) => {
    if (isBenignDevServerError(error)) return
    originalConsoleError(error)
    process.exit(1)
  })

  process.on("unhandledRejection", (reason) => {
    if (isBenignDevServerError(reason)) return
    originalConsoleError("Unhandled Rejection:", reason)
    process.exit(1)
  })
}
