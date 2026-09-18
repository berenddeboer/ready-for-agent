import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { waitForHttp } from "../scripts/wait-for-http.ts"
import { describe, expect, test } from "bun:test"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const allocatePort = async (): Promise<number> => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  })
  const port = probe.port
  await probe.stop(true)
  return port
}

describe("install smoke HTTP readiness polling", () => {
  test("treats a local HTTP response as ready", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    })
    try {
      const response = await waitForHttp(
        `http://127.0.0.1:${server.port}/`,
        1_000,
        () => true,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("ok")
    } finally {
      await server.stop(true)
    }
  })

  test("retries until the local server becomes reachable", async () => {
    const port = await allocatePort()
    const pending = waitForHttp(`http://127.0.0.1:${port}/`, 2_000, () => true)
    await setTimeout(250)
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response("ok", { status: 200 }),
    })
    try {
      const response = await pending
      expect(response.status).toBe(200)
    } finally {
      await server.stop(true)
    }
  })

  test("fails with the URL and last error after the deadline", async () => {
    const url = "http://127.0.0.1:1/"
    let thrown: unknown
    try {
      await waitForHttp(url, 50, () => true)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    expect(message).toContain(`Timed out waiting for ${url}`)
    expect(message.length).toBeGreaterThan(
      `Timed out waiting for ${url}: `.length,
    )
  })

  test("fails with the URL and last error when the process exits first", async () => {
    let alive = true
    const pending = waitForHttp("http://127.0.0.1:1/", 2_000, () => alive)
    await setTimeout(50)
    alive = false
    await expect(pending).rejects.toThrow(
      /Process exited before http:\/\/127\.0\.0\.1:1\/ became ready:/,
    )
  })

  test("accepts a redirect response without requiring 2xx", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/ready" },
          })
        }
        return new Response("ready", { status: 200 })
      },
    })
    try {
      const response = await waitForHttp(
        `http://127.0.0.1:${server.port}/`,
        1_000,
        () => true,
      )
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/ready")
    } finally {
      await server.stop(true)
    }
  })

  test("packed-install and overnight published-install smokes share the helper", () => {
    const packed = readFileSync(
      join(appRoot, "scripts/packed-install-smoke.ts"),
      "utf8",
    )
    const overnight = readFileSync(
      join(appRoot, "scripts/overnight-published-install-smoke.ts"),
      "utf8",
    )
    expect(packed).toContain('from "./wait-for-http.ts"')
    expect(overnight).toContain('from "./wait-for-http.ts"')
    expect(packed).not.toMatch(/const waitForHttp =/)
    expect(overnight).not.toMatch(/const waitForHttp =/)
  })
})
