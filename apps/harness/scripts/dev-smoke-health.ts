export const VITE_LISTENING_MARKER = "[harness:smoke] Vite HTTP listener ready"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Cap each poll so a hung TCP/fetch cannot outrun the overall deadline. */
const GRAPHQL_HEALTH_POLL_MS = 5_000

export const waitForGraphqlHealth = async (
  baseUrl: string,
  timeoutMs: number,
  isAlive: () => boolean,
  isListening: () => boolean,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error(
        `Dev server exited before GraphQL health succeeded: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      )
    }
    // Vite's temporary TCP port probes can accept a poll and then never close.
    // Only contact the real HTTP listener, not a probe using the same port.
    if (!isListening()) {
      lastError = new Error("Vite has not signalled HTTP listening")
      await sleep(250)
      continue
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const pollMs = Math.min(GRAPHQL_HEALTH_POLL_MS, remainingMs)
    try {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ health }" }),
        signal: AbortSignal.timeout(pollMs),
      })
      if (response.status === 200) {
        const payload = (await response.json()) as {
          data?: { health?: boolean }
        }
        if (payload.data?.health === true) {
          return
        }
        lastError = new Error(
          `Unexpected GraphQL payload: ${JSON.stringify(payload)}`,
        )
      } else {
        lastError = new Error(`HTTP ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `Timed out waiting for GraphQL health at ${baseUrl}/graphql: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}
