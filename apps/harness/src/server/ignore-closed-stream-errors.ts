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

/**
 * Node/undici can race a cancelled body stream against its natural close and
 * throw outside the request promise. Keep that teardown race from stopping the
 * dev server while preserving Node's fatal behavior for every other error.
 */
export const ignoreClosedStreamErrors = (): void => {
  const key = Symbol.for("ready-for-agent.ignoreClosedStreamErrors")
  const state = globalThis as typeof globalThis & { [key]?: true }
  if (state[key]) return
  state[key] = true

  process.on("uncaughtException", (error) => {
    if (isBenignClosedStreamError(error)) return
    console.error(error)
    process.exit(1)
  })

  process.on("unhandledRejection", (reason) => {
    if (isBenignClosedStreamError(reason)) return
    console.error("Unhandled Rejection:", reason)
    process.exit(1)
  })
}
