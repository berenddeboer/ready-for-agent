import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  INTERNAL_KEYMAXXER_SIDECAR_ARG,
  KEYMAXXER_SIDECAR_URL_PREFIX,
  isInternalKeymaxxerSidecarMode,
  isStandaloneExecutable,
  resolveKeymaxxerSidecarChildSpawn,
  runKeymaxxerSidecarProcess,
} from "../src/index.js"
import { afterEach, describe, expect, test } from "bun:test"

const freePort = async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("failed to allocate port")
  }
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

describe("internal Keymaxxer Sidecar mode", () => {
  test("detects the hidden internal argv token", () => {
    expect(isInternalKeymaxxerSidecarMode(["bun", "main.ts"])).toBe(false)
    expect(
      isInternalKeymaxxerSidecarMode([
        "ready-for-agent",
        INTERNAL_KEYMAXXER_SIDECAR_ARG,
      ]),
    ).toBe(true)
  })

  test("classifies compiled binaries vs source runtimes", () => {
    expect(
      isStandaloneExecutable("/usr/bin/bun", [
        "/usr/bin/bun",
        "/app/server.ts",
      ]),
    ).toBe(false)
    expect(
      isStandaloneExecutable("/opt/ready-for-agent", [
        "/opt/ready-for-agent",
        "start",
      ]),
    ).toBe(true)
    expect(
      isStandaloneExecutable("/opt/ready-for-agent", ["/opt/ready-for-agent"]),
    ).toBe(true)
  })

  test("spawns the same binary with the internal mode flag when standalone", () => {
    expect(
      resolveKeymaxxerSidecarChildSpawn({
        execPath: "/opt/ready-for-agent",
        argv: ["/opt/ready-for-agent", "start"],
      }),
    ).toEqual({
      command: "/opt/ready-for-agent",
      args: [INTERNAL_KEYMAXXER_SIDECAR_ARG],
    })
  })

  test("re-invokes the current source entry with workspace conditions", () => {
    expect(
      resolveKeymaxxerSidecarChildSpawn({
        execPath: "/usr/bin/bun",
        argv: ["/usr/bin/bun", "/repo/apps/harness/server.ts"],
      }),
    ).toEqual({
      command: "/usr/bin/bun",
      args: [
        "--conditions",
        "@ready-for-agent/source",
        "/repo/apps/harness/server.ts",
        INTERNAL_KEYMAXXER_SIDECAR_ARG,
      ],
    })
  })
})

describe("Keymaxxer Sidecar process bootstrap", () => {
  const children: Array<ReturnType<typeof spawn>> = []

  afterEach(() => {
    for (const child of children) {
      child.kill("SIGTERM")
    }
    children.length = 0
  })

  test("prints a private bootstrap URL and never logs the capability path", async () => {
    const port = await freePort()
    const serverEntry = fileURLToPath(
      new URL("../../../apps/harness/server.ts", import.meta.url),
    )
    const child = spawn(
      process.execPath,
      [
        "--conditions",
        "@ready-for-agent/source",
        serverEntry,
        INTERNAL_KEYMAXXER_SIDECAR_ARG,
      ],
      {
        env: {
          ...process.env,
          KEYMAXXER_SIDECAR_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    children.push(child)

    const bootstrapUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("timed out waiting for bootstrap URL"))
      }, 15_000)

      let stderr = ""
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      if (child.stdout === null) {
        clearTimeout(timeout)
        reject(new Error("stdout not captured"))
        return
      }

      const lines = createInterface({ input: child.stdout })
      lines.on("line", (line) => {
        if (!line.startsWith(KEYMAXXER_SIDECAR_URL_PREFIX)) return
        clearTimeout(timeout)
        lines.close()
        const url = line.slice(KEYMAXXER_SIDECAR_URL_PREFIX.length).trim()
        resolve(url)
        // capability must not appear on stderr logs
        expect(stderr.includes(url)).toBe(false)
        const capability = new URL(url).pathname.split("/")[1]
        if (capability) {
          expect(stderr.includes(capability)).toBe(false)
        }
      })

      child.on("exit", (code) => {
        clearTimeout(timeout)
        reject(
          new Error(
            `sidecar exited before bootstrap (code ${code ?? "?"}): ${stderr}`,
          ),
        )
      })
    })

    expect(bootstrapUrl.startsWith(`http://127.0.0.1:${port}/`)).toBe(true)
    expect(bootstrapUrl.endsWith("/mcp")).toBe(true)

    const originRejected = await fetch(bootstrapUrl, {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    })
    expect(originRejected.status).toBe(403)

    child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
    })
  })

  test("runKeymaxxerSidecarProcess exits non-zero when the port is occupied", async () => {
    const occupying = createServer()
    await new Promise<void>((resolve, reject) => {
      occupying.once("error", reject)
      occupying.listen(0, "127.0.0.1", () => resolve())
    })
    const address = occupying.address()
    if (address === null || typeof address === "string") {
      occupying.close()
      throw new Error("failed to bind occupying server")
    }

    const exits: number[] = []
    await runKeymaxxerSidecarProcess({
      environment: {
        KEYMAXXER_SIDECAR_PORT: String(address.port),
      },
      exitProcess: (code) => {
        exits.push(code)
      },
      waitForever: async () => {},
    })

    expect(exits).toEqual([1])
    await new Promise<void>((resolve, reject) => {
      occupying.close((error) => (error ? reject(error) : resolve()))
    })
  })
})
