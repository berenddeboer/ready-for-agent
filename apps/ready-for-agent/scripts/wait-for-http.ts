const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll until `url` yields any HTTP response (status > 0), including redirects.
 * A crashed child fails fast through `isAlive` with the URL and last fetch error.
 */
export const waitForHttp = async (
  url: string,
  timeoutMs: number,
  isAlive: () => boolean,
): Promise<Response> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error(
        `Process exited before ${url} became ready: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      )
    }
    try {
      const response = await fetch(url, { redirect: "manual" })
      if (response.status > 0) {
        return response
      }
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(
    `Timed out waiting for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}
