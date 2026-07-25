import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  KEYMAXXER_SIDECAR_URL_PREFIX,
  type KeymaxxerUpstreamClient,
  MAX_UNLOCK_ATTEMPTS,
  isWrongPassphraseResult,
  startKeymaxxerFacade,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

const listResult = (
  secrets: Array<{ name: string; provider?: string; account?: string }> = [
    { name: "DEMO", provider: "github", account: "acme/widgets" },
  ],
) => ({
  content: [{ type: "text", text: JSON.stringify(secrets) }],
})

const wrongPassphraseResult = () => ({
  content: [{ type: "text", text: "error: wrong passphrase." }],
  isError: true as const,
})

const runOkResult = () => ({
  content: [
    {
      type: "text",
      text: "exit_code: 0\n--- stdout ---\nok\n--- stderr ---\n",
    },
  ],
})

const mockUpstream = (
  secrets: Array<{ name: string; provider?: string; account?: string }> = [
    { name: "DEMO", provider: "github", account: "acme/widgets" },
  ],
): KeymaxxerUpstreamClient => ({
  callTool: async ({ name }) => {
    if (name === "keymaxxer_list") {
      return listResult(secrets)
    }
    if (name === "keymaxxer_run") {
      return runOkResult()
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

const toolText = (result: { content?: unknown }): string =>
  Array.isArray(result.content)
    ? result.content
        .map((item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof item.text === "string"
            ? item.text
            : "",
        )
        .join("\n")
    : ""

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

  test("retries unlock probe after wrong passphrase then continues the original operation", async () => {
    const calls: string[] = []
    let listAttempts = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          calls.push(name)
          if (name === "keymaxxer_list") {
            listAttempts += 1
            if (listAttempts === 1) return wrongPassphraseResult()
            return listResult()
          }
          if (name === "keymaxxer_run") return runOkResult()
          return { content: [{ type: "text", text: "ok" }] }
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const connection = await connectClient(facade.url)
      try {
        const result = await connection.client.callTool({
          name: "keymaxxer_run",
          arguments: {
            command: "true",
            secrets: ["DEMO"],
          },
        })
        expect(result.isError).not.toBe(true)
        expect(toolText(result)).toContain("exit_code: 0")
        // Unlock probe (fail + success) then the original run — no generic re-run.
        expect(calls).toEqual([
          "keymaxxer_list",
          "keymaxxer_list",
          "keymaxxer_run",
        ])
        expect(listAttempts).toBe(2)
      } finally {
        await connection.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("returns an actionable error after exhausted unlock retries", async () => {
    let listAttempts = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          if (name === "keymaxxer_list") {
            listAttempts += 1
            return wrongPassphraseResult()
          }
          throw new Error(`unexpected tool ${name}`)
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const connection = await connectClient(facade.url)
      try {
        const result = await connection.client.callTool({
          name: "keymaxxer_run",
          arguments: {
            command: "true",
            secrets: ["DEMO"],
          },
        })
        expect(result.isError).toBe(true)
        expect(toolText(result)).toMatch(
          /vault unlock failed after 3 attempts/i,
        )
        expect(toolText(result).toLowerCase()).toContain("wrong passphrase")
        expect(listAttempts).toBe(MAX_UNLOCK_ATTEMPTS)
      } finally {
        await connection.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("allows concurrent keymaxxer_list while keymaxxer_run waits on approval", async () => {
    let releaseApproval!: () => void
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    let runStarted = false
    let listDuringApproval = 0
    const runStartedSignal = Promise.withResolvers<void>()

    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          if (name === "keymaxxer_list") {
            if (runStarted) listDuringApproval += 1
            return listResult()
          }
          if (name === "keymaxxer_run") {
            runStarted = true
            runStartedSignal.resolve()
            await approvalGate
            return runOkResult()
          }
          return { content: [{ type: "text", text: "ok" }] }
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const [runner, lister] = await Promise.all([
        connectClient(facade.url),
        connectClient(facade.url),
      ])
      try {
        // Establish unlocked state first so list can bypass the dialog lane.
        const unlock = await lister.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        expect(unlock.isError).not.toBe(true)

        const runPromise = runner.client.callTool({
          name: "keymaxxer_run",
          arguments: {
            command: "true",
            secrets: ["DEMO"],
          },
        })

        await runStartedSignal.promise

        const listStarted = Date.now()
        const listResultCall = await lister.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        const listElapsedMs = Date.now() - listStarted

        expect(listResultCall.isError).not.toBe(true)
        expect(listDuringApproval).toBe(1)
        // List must complete while run is still blocked on approval.
        expect(listElapsedMs).toBeLessThan(500)

        releaseApproval()
        const runResult = await runPromise
        expect(runResult.isError).not.toBe(true)
      } finally {
        await runner.transport.close()
        await lister.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("shares one unlock probe across concurrent first operations", async () => {
    let listAttempts = 0
    let unlockHold!: () => void
    const unlockGate = new Promise<void>((resolve) => {
      unlockHold = resolve
    })
    const firstListStarted = Promise.withResolvers<void>()

    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          if (name === "keymaxxer_list") {
            listAttempts += 1
            if (listAttempts === 1) firstListStarted.resolve()
            await unlockGate
            return listResult()
          }
          if (name === "keymaxxer_run") return runOkResult()
          return { content: [{ type: "text", text: "ok" }] }
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const [a, b] = await Promise.all([
        connectClient(facade.url),
        connectClient(facade.url),
      ])
      try {
        const runA = a.client.callTool({
          name: "keymaxxer_run",
          arguments: { command: "true", secrets: ["DEMO"] },
        })
        const runB = b.client.callTool({
          name: "keymaxxer_run",
          arguments: { command: "true", secrets: ["DEMO"] },
        })
        await firstListStarted.promise
        // Still gated on unlock — concurrent waiters must not start a second probe.
        expect(listAttempts).toBe(1)
        unlockHold()
        const [resultA, resultB] = await Promise.all([runA, runB])
        expect(resultA.isError).not.toBe(true)
        expect(resultB.isError).not.toBe(true)
        // One shared unlock list, then two runs (serialized on dialog lane).
        expect(listAttempts).toBe(1)
      } finally {
        await a.transport.close()
        await b.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("re-probes unlock before run when unlockObserved was cleared after ensureUnlocked", async () => {
    const calls: string[] = []
    let runCalls = 0
    let releaseFirstRun!: () => void
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    const firstRunStarted = Promise.withResolvers<void>()

    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          calls.push(name)
          if (name === "keymaxxer_list") return listResult()
          if (name === "keymaxxer_run") {
            runCalls += 1
            if (runCalls === 1) {
              firstRunStarted.resolve()
              await firstRunGate
              throw new Error("keyholder exited mid-run")
            }
            return runOkResult()
          }
          return { content: [{ type: "text", text: "ok" }] }
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const [a, b] = await Promise.all([
        connectClient(facade.url),
        connectClient(facade.url),
      ])
      try {
        // Establish unlocked state so both runs skip the outer ensureUnlocked.
        await a.client.callTool({ name: "keymaxxer_list", arguments: {} })
        const listAfterUnlock = calls.filter(
          (c) => c === "keymaxxer_list",
        ).length

        const runA = a.client.callTool({
          name: "keymaxxer_run",
          arguments: { command: "true", secrets: ["DEMO"] },
        })
        await firstRunStarted.promise

        // Second run is past ensureUnlocked (still unlocked) and queues on the
        // dialog lane behind the first run. When the first throws, unlock is
        // cleared; the second must re-probe with list before keymaxxer_run.
        const runB = b.client.callTool({
          name: "keymaxxer_run",
          arguments: { command: "true", secrets: ["DEMO"] },
        })

        // Let B enqueue on the dialog lane before A fails and clears unlock.
        await Bun.sleep(50)
        releaseFirstRun()

        const [resultA, resultB] = await Promise.all([runA, runB])
        expect(resultA.isError).toBe(true)
        expect(resultB.isError).not.toBe(true)
        expect(toolText(resultB)).toContain("exit_code: 0")

        const listAfter = calls.filter((c) => c === "keymaxxer_list").length
        expect(listAfter).toBeGreaterThan(listAfterUnlock)
        // Final successful path is list re-probe then run (not bare run).
        const lastList = calls.lastIndexOf("keymaxxer_list")
        const lastRun = calls.lastIndexOf("keymaxxer_run")
        expect(lastList).toBeGreaterThan(-1)
        expect(lastRun).toBeGreaterThan(lastList)
      } finally {
        await a.transport.close()
        await b.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("does not return unlock list payload as keymaxxer_run result after unlock", async () => {
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          if (name === "keymaxxer_list") return listResult()
          if (name === "keymaxxer_run") return runOkResult()
          return { content: [{ type: "text", text: "ok" }] }
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const connection = await connectClient(facade.url)
      try {
        const result = await connection.client.callTool({
          name: "keymaxxer_run",
          arguments: { command: "true", secrets: ["DEMO"] },
        })
        expect(result.isError).not.toBe(true)
        // Run result shape, not the unlock probe's secret metadata list JSON.
        expect(toolText(result)).toContain("exit_code: 0")
        expect(toolText(result)).not.toContain('"name":"DEMO"')
      } finally {
        await connection.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("re-enters unlock path after wrong-passphrase list once unlocked", async () => {
    let listCalls = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          if (name === "keymaxxer_list") {
            listCalls += 1
            // First list unlocks; second simulates idle re-lock wrong passphrase.
            if (listCalls === 1) return listResult()
            if (listCalls === 2) return wrongPassphraseResult()
            return listResult()
          }
          return { content: [{ type: "text", text: "ok" }] }
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const connection = await connectClient(facade.url)
      try {
        const unlocked = await connection.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        expect(unlocked.isError).not.toBe(true)

        const locked = await connection.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        expect(locked.isError).toBe(true)

        // After wrong passphrase, a subsequent list should re-probe unlock.
        const again = await connection.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        expect(again.isError).not.toBe(true)
        expect(listCalls).toBe(3)
      } finally {
        await connection.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("probes unlock with keymaxxer_list before the first keymaxxer_run", async () => {
    const calls: string[] = []
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => ({
        callTool: async ({ name }) => {
          calls.push(name)
          if (name === "keymaxxer_list") return listResult()
          if (name === "keymaxxer_run") return runOkResult()
          return { content: [{ type: "text", text: "ok" }] }
        },
        close: async () => {},
      }),
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const connection = await connectClient(facade.url)
      try {
        await connection.client.callTool({
          name: "keymaxxer_run",
          arguments: { command: "true", secrets: ["DEMO"] },
        })
        expect(calls).toEqual(["keymaxxer_list", "keymaxxer_run"])
      } finally {
        await connection.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("does not replay a side-effecting request after transport failure", async () => {
    let upstreamSpawns = 0
    let runCalls = 0
    const facade = await startKeymaxxerFacade({
      host: "127.0.0.1",
      port: 0,
      createUpstream: async () => {
        upstreamSpawns += 1
        if (upstreamSpawns === 1) {
          return {
            callTool: async ({ name }) => {
              if (name === "keymaxxer_list") return listResult()
              runCalls += 1
              throw new Error("keyholder exited mid-run")
            },
            close: async () => {},
          }
        }
        return {
          callTool: async ({ name }) => {
            if (name === "keymaxxer_list") return listResult()
            runCalls += 1
            return runOkResult()
          },
          close: async () => {},
        }
      },
      onBootstrapUrl: () => {},
      log: () => {},
    })

    try {
      const connection = await connectClient(facade.url)
      try {
        const failed = await connection.client.callTool({
          name: "keymaxxer_run",
          arguments: { command: "echo once", secrets: ["DEMO"] },
        })
        expect(failed.isError).toBe(true)
        // Unlock probe + one failed run on the first keyholder.
        expect(runCalls).toBe(1)
        expect(upstreamSpawns).toBe(1)

        const recovered = await connection.client.callTool({
          name: "keymaxxer_list",
          arguments: {},
        })
        expect(recovered.isError).not.toBe(true)
        expect(upstreamSpawns).toBe(2)
        // Recovery list does not re-run the failed side-effecting command.
        expect(runCalls).toBe(1)
      } finally {
        await connection.transport.close()
      }
    } finally {
      await facade.stop()
    }
  })

  test("isWrongPassphraseResult detects Keymaxxer unlock text", () => {
    expect(isWrongPassphraseResult(wrongPassphraseResult())).toBe(true)
    expect(
      isWrongPassphraseResult({
        content: [{ type: "text", text: "error: no vault found." }],
        isError: true,
      }),
    ).toBe(false)
    expect(
      isWrongPassphraseResult({
        content: [{ type: "text", text: "error: wrong passphrase." }],
      }),
    ).toBe(false)
  })
})
