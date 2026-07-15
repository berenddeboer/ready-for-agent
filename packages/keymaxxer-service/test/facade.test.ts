import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  KEYMAXXER_SIDECAR_URL_PREFIX,
  type KeymaxxerUpstreamClient,
  startKeymaxxerFacade,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const mockUpstream = (
  secrets: Array<{ name: string; provider?: string; account?: string }> = [
    { name: "DEMO", provider: "github", account: "acme/widgets" },
  ],
): KeymaxxerUpstreamClient => ({
  callTool: async ({ name }) => {
    if (name === "keymaxxer_list") {
      return {
        content: [{ type: "text", text: JSON.stringify(secrets) }],
      }
    }
    if (name === "keymaxxer_run") {
      return {
        content: [
          {
            type: "text",
            text: "exit_code: 0\n--- stdout ---\nok\n--- stderr ---\n",
          },
        ],
      }
    }
    return { content: [{ type: "text", text: "ok" }] }
  },
  close: async () => {},
})

const connectClient = async (url: string) => {
  const client = new Client({ name: "test", version: "0.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  return { client, transport }
}

describe("Keymaxxer MCP facade security surface", () => {
  test("rejects Origin, wrong path, and has no health route", async () => {
    const bootstrap: string[] = []
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => mockUpstream(),
      onBootstrapUrl: (url) => bootstrap.push(url),
      log: () => {},
    })

    try {
      expect(bootstrap).toHaveLength(1)
      expect(bootstrap[0]).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/mcp$/,
      )

      const origin = await fetch(facade.url, {
        headers: { origin: "http://evil.example" },
      })
      expect(origin.status).toBe(403)

      const wrongPath = await fetch(
        `http://127.0.0.1:${facade.port}/not-the-capability/mcp`,
      )
      expect(wrongPath.status).toBe(404)

      const health = await fetch(`http://127.0.0.1:${facade.port}/health`)
      expect(health.status).toBe(404)

      const root = await fetch(`http://127.0.0.1:${facade.port}/`)
      expect(root.status).toBe(404)
    } finally {
      await facade.stop()
    }
  })

  test("serves the four Keymaxxer tools to concurrent MCP clients on one upstream", async () => {
    let upstreamSpawns = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => {
        upstreamSpawns += 1
        return mockUpstream()
      },
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const [a, b] = await Promise.all([
        connectClient(facade.url),
        connectClient(facade.url),
      ])
      try {
        const [toolsA, toolsB] = await Promise.all([
          a.client.listTools(),
          b.client.listTools(),
        ])
        const namesA = toolsA.tools.map((tool) => tool.name).sort()
        const namesB = toolsB.tools.map((tool) => tool.name).sort()
        expect(namesA).toEqual([
          "keymaxxer_add",
          "keymaxxer_list",
          "keymaxxer_rm",
          "keymaxxer_run",
        ])
        expect(namesB).toEqual(namesA)

        await Promise.all([
          a.client.callTool({ name: "keymaxxer_list", arguments: {} }),
          b.client.callTool({ name: "keymaxxer_list", arguments: {} }),
        ])
        expect(upstreamSpawns).toBe(1)
      } finally {
        await a.transport.close()
        await b.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("starts a fresh keyholder after the current keyholder fails", async () => {
    let upstreamSpawns = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => {
        upstreamSpawns += 1
        if (upstreamSpawns === 1) {
          return {
            callTool: async () => {
              throw new Error("keyholder exited")
            },
            close: async () => {},
          }
        }
        return mockUpstream()
      },
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const connection = await connectClient(facade.url)
      try {
        const failed = await connection.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        expect(failed.isError).toBe(true)

        const result = await connection.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        expect(result.isError).not.toBe(true)
        expect(upstreamSpawns).toBe(2)
      } finally {
        await connection.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("prints a single bootstrap line prefix for harness capture", async () => {
    let written = ""
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stdout.write

    try {
      const facade = await startKeymaxxerFacade({
        host: "127.0.0.1",
        port: 0,
        createUpstream: async () => mockUpstream(),
        log: () => {},
      })
      try {
        expect(written).toContain(
          `${KEYMAXXER_SIDECAR_URL_PREFIX}${facade.url}`,
        )
      } finally {
        await facade.stop()
      }
    } finally {
      process.stdout.write = originalWrite
    }
  })
})
