import { type Socket, createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { waitForGraphqlHealth } from "../scripts/dev-smoke-health.ts"
import { describe, expect, test } from "bun:test"

describe("dev smoke health polling", () => {
  test("leaves the temporary port probe alone until the real HTTP server is listening", async () => {
    const connections: Socket[] = []
    // Vite briefly binds a raw TCP server and waits for close before HTTP startup.
    const probe = createServer((socket) => connections.push(socket))
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const address = probe.address()
    if (address === null || typeof address === "string") {
      throw new Error("Port probe did not bind a TCP port")
    }
    let listening = false
    let alive = true
    let httpServer: ReturnType<typeof Bun.serve> | undefined
    const result = waitForGraphqlHealth(
      `http://127.0.0.1:${address.port}`,
      2_000,
      () => alive,
      () => listening,
    ).then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await setTimeout(300)
      expect(connections).toHaveLength(0)
      await new Promise<void>((resolve, reject) => {
        probe.close((error) =>
          error === undefined ? resolve() : reject(error),
        )
      })
      httpServer = Bun.serve({
        hostname: "127.0.0.1",
        port: address.port,
        async fetch(request) {
          expect(request.method).toBe("POST")
          expect(new URL(request.url).pathname).toBe("/graphql")
          expect(await request.json()).toEqual({ query: "{ health }" })
          return Response.json({ data: { health: true } })
        },
      })
      listening = true
      expect(await result).toBeNull()
    } finally {
      alive = false
      for (const socket of connections) socket.destroy()
      probe.close()
      await httpServer?.stop(true)
      await result
    }
  })

  test("still enforces the deadline if Vite never signals listening", async () => {
    await expect(
      waitForGraphqlHealth(
        "http://127.0.0.1:1",
        10,
        () => true,
        () => false,
      ),
    ).rejects.toThrow("Timed out waiting for GraphQL health")
  })

  test("still detects process exit before Vite signals listening", async () => {
    await expect(
      waitForGraphqlHealth(
        "http://127.0.0.1:1",
        1_000,
        () => false,
        () => false,
      ),
    ).rejects.toThrow("Dev server exited before GraphQL health succeeded")
  })
})
