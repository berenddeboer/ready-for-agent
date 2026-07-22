import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { createServer } from "node:net"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  INTERNAL_KEYMAXXER_SIDECAR_ARG,
  KEYMAXXER_SIDECAR_URL_PREFIX,
  resolveKeymaxxerSidecarChildSpawn,
} from "@ready-for-agent/keymaxxer-service"
import {
  type Application,
  type HttpServerHandle,
  type OwnedChildProcess,
  type ProductionLifecycleEvent,
  resolveKeymaxxerMode,
  startProductionLifecycle,
} from "../src/server/production-lifecycle.ts"
import { afterEach, describe, expect, test } from "bun:test"

class FakeChild extends EventEmitter implements OwnedChildProcess {
  killed = false
  kill(_signal?: NodeJS.Signals) {
    this.killed = true
    return true
  }
}

const fakeApplication = (): Application => ({
  context: {
    graphqlApi: {
      fetch: async () => new Response("ok"),
    },
  },
  dispose: async () => {
    disposed.push("application")
  },
})

const disposed: string[] = []
const events: ProductionLifecycleEvent[] = []
const logs: string[] = []
const errors: string[] = []
const exits: number[] = []
const browserOpens: string[] = []
const migrationOrder: string[] = []
const applicationEnvs: NodeJS.ProcessEnv[] = []

afterEach(() => {
  disposed.length = 0
  events.length = 0
  logs.length = 0
  errors.length = 0
  exits.length = 0
  browserOpens.length = 0
  migrationOrder.length = 0
  applicationEnvs.length = 0
})

const baseOptions = () => {
  const server: HttpServerHandle = {
    port: 4242,
    stop: async () => {
      disposed.push("server")
    },
  }
  return {
    waitForShutdown: false as const,
    environment: {
      SQLITE_DATABASE_PATH: "/tmp/unused.db",
      KEYMAXXER_ENABLED: "false",
    } satisfies NodeJS.ProcessEnv,
    argv: ["bun", "server.ts"],
    applyMigrations: async () => {
      migrationOrder.push("migrate")
    },
    createApplication: async (environment: NodeJS.ProcessEnv) => {
      applicationEnvs.push({ ...environment })
      return fakeApplication()
    },
    loadStartHandler: async () => ({
      fetch: async () => new Response("handler"),
    }),
    serveHttp: async () => server,
    openBrowser: (url: string) => {
      browserOpens.push(url)
    },
    onEvent: (event: ProductionLifecycleEvent) => {
      events.push(event)
    },
    logInfo: (message: string) => {
      logs.push(message)
    },
    logError: (message: string) => {
      errors.push(message)
    },
    exitProcess: (code: number) => {
      exits.push(code)
    },
    installSignalHandlers: () => () => {},
  }
}

describe("production lifecycle keymaxxer mode", () => {
  test("disables when KEYMAXXER_ENABLED=false", () => {
    expect(resolveKeymaxxerMode({ KEYMAXXER_ENABLED: "false" })).toEqual({
      kind: "disabled",
    })
  })

  test("reuses an existing sidecar URL", () => {
    expect(
      resolveKeymaxxerMode({
        KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
      }),
    ).toEqual({
      kind: "existing-url",
      url: "http://127.0.0.1:6057/cap/mcp",
    })
  })

  test("disables when Keymaxxer is absent (no entrypoint and not on PATH)", () => {
    expect(resolveKeymaxxerMode({}, () => false)).toEqual({ kind: "disabled" })
  })

  test("spawns a Sidecar when Keymaxxer is available", () => {
    expect(resolveKeymaxxerMode({}, () => true)).toEqual({
      kind: "spawn-sidecar",
    })
  })
})

describe("production lifecycle process behavior", () => {
  test("runs migrations before HTTP readiness and opens browser once", async () => {
    let httpAfterMigrate = false
    const handle = await startProductionLifecycle({
      ...baseOptions(),
      serveHttp: async () => {
        httpAfterMigrate = migrationOrder.includes("migrate")
        return {
          port: 4242,
          stop: async () => {
            disposed.push("server")
          },
        }
      },
    })

    expect(httpAfterMigrate).toBe(true)
    expect(events).toEqual([
      "database-ready",
      "application-ready",
      "http-ready",
      "browser-open",
    ])
    expect(browserOpens).toEqual(["http://127.0.0.1:4242/"])
    expect(logs.some((line) => line.includes("listening on"))).toBe(true)
    expect(applicationEnvs[0]?.KEYMAXXER_ENABLED).toBe("false")

    await handle.dispose()
    expect(events).toContain("shutdown-start")
    expect(events).toContain("shutdown-complete")
    expect(disposed).toEqual(["server", "application"])
  })

  test("readiness log includes non-placeholder version and listening URL", async () => {
    const handle = await startProductionLifecycle({
      ...baseOptions(),
      version: "1.2.3",
    })

    const readiness = logs.find((line) => line.includes("listening on"))
    expect(readiness).toBeDefined()
    expect(readiness).toContain("v1.2.3")
    expect(readiness).toContain("http://127.0.0.1:4242")
    expect(readiness).toBe(
      "Ready for Agent v1.2.3 listening on http://127.0.0.1:4242",
    )

    await handle.dispose()
  })

  test("respects --no-open and NO_BROWSER", async () => {
    const noOpen = await startProductionLifecycle({
      ...baseOptions(),
      argv: ["bun", "server.ts", "--no-open"],
      onEvent: (event) => {
        events.push(event)
      },
      applyMigrations: async () => {},
    })
    expect(browserOpens).toEqual([])
    expect(events).not.toContain("browser-open")
    await noOpen.dispose()

    events.length = 0
    browserOpens.length = 0
    const noBrowser = await startProductionLifecycle({
      ...baseOptions(),
      environment: {
        SQLITE_DATABASE_PATH: "/tmp/unused.db",
        KEYMAXXER_ENABLED: "false",
        NO_BROWSER: "1",
      },
      onEvent: (event) => {
        events.push(event)
      },
      applyMigrations: async () => {},
    })
    expect(browserOpens).toEqual([])
    expect(events).not.toContain("browser-open")
    await noBrowser.dispose()
  })

  test("gates application startup on owned Sidecar readiness", async () => {
    const child = new FakeChild()
    let applicationStarted = false
    const order: string[] = []

    const handle = await startProductionLifecycle({
      ...baseOptions(),
      environment: {
        SQLITE_DATABASE_PATH: "/tmp/unused.db",
      },
      resolveKeymaxxerMode: () => ({ kind: "spawn-sidecar" }),
      startSidecar: async () => {
        order.push("sidecar")
        return {
          url: "http://127.0.0.1:6057/capability/mcp",
          child,
        }
      },
      applyMigrations: async () => {
        order.push("migrate")
      },
      createApplication: async (environment) => {
        applicationStarted = true
        order.push("application")
        expect(environment.KEYMAXXER_SIDECAR_URL).toBe(
          "http://127.0.0.1:6057/capability/mcp",
        )
        return fakeApplication()
      },
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(applicationStarted).toBe(true)
    expect(order).toEqual(["migrate", "sidecar", "application"])
    expect(events).toContain("sidecar-ready")
    expect(events.indexOf("sidecar-ready")).toBeLessThan(
      events.indexOf("application-ready"),
    )
    expect(events.indexOf("application-ready")).toBeLessThan(
      events.indexOf("http-ready"),
    )

    await handle.dispose()
    expect(child.killed).toBe(true)
  })

  test("startup failure after Sidecar spawn disposes owned child", async () => {
    const child = new FakeChild()

    await expect(
      startProductionLifecycle({
        ...baseOptions(),
        environment: {
          SQLITE_DATABASE_PATH: "/tmp/unused.db",
        },
        resolveKeymaxxerMode: () => ({ kind: "spawn-sidecar" }),
        startSidecar: async () => ({
          url: "http://127.0.0.1:6057/capability/mcp",
          child,
        }),
        applyMigrations: async () => {},
        createApplication: async () => {
          throw new Error("application boom")
        },
        onEvent: (event) => {
          events.push(event)
        },
      }),
    ).rejects.toThrow("application boom")

    expect(child.killed).toBe(true)
    expect(events).toContain("shutdown-start")
    expect(events).toContain("shutdown-complete")
  })

  test("configured Sidecar spawn failure stops startup without ambient fallback", async () => {
    await expect(
      startProductionLifecycle({
        ...baseOptions(),
        environment: {
          SQLITE_DATABASE_PATH: "/tmp/unused.db",
        },
        resolveKeymaxxerMode: () => ({ kind: "spawn-sidecar" }),
        startSidecar: async () => {
          throw new Error("sidecar refused")
        },
        applyMigrations: async () => {},
        createApplication: async () => {
          throw new Error("should not create application")
        },
        onEvent: (event) => {
          events.push(event)
        },
      }),
    ).rejects.toThrow("sidecar refused")

    expect(events).toEqual(["database-ready"])
    expect(applicationEnvs).toEqual([])
  })

  test("unexpected owned child exit fails the Harness with a clear non-zero exit", async () => {
    const child = new FakeChild()

    const handle = await startProductionLifecycle({
      ...baseOptions(),
      environment: {
        SQLITE_DATABASE_PATH: "/tmp/unused.db",
      },
      resolveKeymaxxerMode: () => ({ kind: "spawn-sidecar" }),
      startSidecar: async () => ({
        url: "http://127.0.0.1:6057/capability/mcp",
        child,
      }),
      applyMigrations: async () => {},
      onEvent: (event) => {
        events.push(event)
      },
    })

    child.emit("exit", 7, null)
    await Bun.sleep(20)

    expect(events).toContain("child-failed")
    expect(
      errors.some((line) => line.includes("Keymaxxer Sidecar exited")),
    ).toBe(true)
    expect(exits).toContain(1)
    expect(disposed).toContain("server")
    expect(disposed).toContain("application")
    expect(child.killed).toBe(true)

    // dispose is idempotent after child-failure cleanup
    await handle.dispose()
  })

  test("SIGINT disposes HTTP server, application, and owned child", async () => {
    const child = new FakeChild()
    let triggerShutdown: ((signal: NodeJS.Signals) => void) | undefined

    const handle = await startProductionLifecycle({
      ...baseOptions(),
      environment: {
        SQLITE_DATABASE_PATH: "/tmp/unused.db",
      },
      resolveKeymaxxerMode: () => ({ kind: "spawn-sidecar" }),
      startSidecar: async () => ({
        url: "http://127.0.0.1:6057/capability/mcp",
        child,
      }),
      applyMigrations: async () => {},
      installSignalHandlers: (shutdown) => {
        triggerShutdown = shutdown
        return () => {
          triggerShutdown = undefined
        }
      },
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(triggerShutdown).toBeTypeOf("function")
    triggerShutdown!("SIGINT")
    await Bun.sleep(20)

    expect(events).toContain("shutdown-start")
    expect(events).toContain("shutdown-complete")
    expect(disposed).toEqual(["server", "application"])
    expect(child.killed).toBe(true)
    expect(exits).toContain(0)

    await handle.dispose()
  })

  test("existing Sidecar URL is supplied to the application without spawning", async () => {
    let startSidecarCalls = 0
    const handle = await startProductionLifecycle({
      ...baseOptions(),
      environment: {
        SQLITE_DATABASE_PATH: "/tmp/unused.db",
        KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
      },
      startSidecar: async () => {
        startSidecarCalls += 1
        throw new Error("should not spawn")
      },
      applyMigrations: async () => {},
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(startSidecarCalls).toBe(0)
    expect(applicationEnvs[0]?.KEYMAXXER_SIDECAR_URL).toBe(
      "http://127.0.0.1:6057/cap/mcp",
    )
    expect(events).toContain("sidecar-ready")
    await handle.dispose()
  })

  test("default owned Sidecar spawn uses internal mode, not workspace main.ts", () => {
    const spawnPlan = resolveKeymaxxerSidecarChildSpawn({
      execPath: process.execPath,
      argv: [
        process.execPath,
        fileURLToPath(new URL("../server.ts", import.meta.url)),
      ],
    })
    expect(spawnPlan.args).toContain(INTERNAL_KEYMAXXER_SIDECAR_ARG)
    expect(spawnPlan.args.join(" ")).not.toContain(
      "keymaxxer-sidecar/src/main.ts",
    )
  })

  test("captures capability URL from an owned internal-mode Sidecar process", async () => {
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

    const port = await freePort()
    const serverEntry = fileURLToPath(new URL("../server.ts", import.meta.url))
    const spawnPlan = resolveKeymaxxerSidecarChildSpawn({
      execPath: process.execPath,
      argv: [process.execPath, serverEntry],
    })

    let capturedUrl: string | undefined
    const logs: string[] = []

    const handle = await startProductionLifecycle({
      ...baseOptions(),
      environment: {
        SQLITE_DATABASE_PATH: "/tmp/unused.db",
        KEYMAXXER_SIDECAR_PORT: String(port),
      },
      resolveKeymaxxerMode: () => ({ kind: "spawn-sidecar" }),
      sidecarSpawn: spawnPlan,
      sidecarBootstrapTimeoutMs: 15_000,
      applyMigrations: async () => {},
      createApplication: async (environment) => {
        capturedUrl = environment.KEYMAXXER_SIDECAR_URL
        return fakeApplication()
      },
      logInfo: (message) => {
        logs.push(message)
      },
      logError: (message) => {
        errors.push(message)
      },
      onEvent: (event) => {
        events.push(event)
      },
      argv: ["bun", "server.ts", "--no-open"],
    })

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl?.startsWith(`http://127.0.0.1:${port}/`)).toBe(true)
    expect(capturedUrl?.endsWith("/mcp")).toBe(true)
    expect(events).toContain("sidecar-ready")
    expect(events.indexOf("sidecar-ready")).toBeLessThan(
      events.indexOf("application-ready"),
    )
    // Full capability URL must not appear in parent logs
    expect(logs.some((line) => line.includes(capturedUrl!))).toBe(false)
    expect(errors.some((line) => line.includes(capturedUrl!))).toBe(false)

    await handle.dispose()
  })

  test("absence of Keymaxxer selects ambient mode without spawning", async () => {
    let startSidecarCalls = 0
    const handle = await startProductionLifecycle({
      ...baseOptions(),
      environment: {
        SQLITE_DATABASE_PATH: "/tmp/unused.db",
      },
      resolveKeymaxxerMode: (environment) =>
        resolveKeymaxxerMode(environment, () => false),
      startSidecar: async () => {
        startSidecarCalls += 1
        throw new Error("should not spawn when keymaxxer is absent")
      },
      applyMigrations: async () => {},
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(startSidecarCalls).toBe(0)
    expect(applicationEnvs[0]?.KEYMAXXER_ENABLED).toBe("false")
    expect(applicationEnvs[0]?.KEYMAXXER_SIDECAR_URL).toBeUndefined()
    expect(events).not.toContain("sidecar-ready")
    await handle.dispose()
  })
})

describe("internal Sidecar mode process entry", () => {
  test("server.ts internal mode bootstraps without workspace sidecar main", async () => {
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

    const port = await freePort()
    const serverEntry = fileURLToPath(new URL("../server.ts", import.meta.url))
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

    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for internal mode bootstrap"))
        }, 15_000)
        if (child.stdout === null) {
          clearTimeout(timeout)
          reject(new Error("stdout missing"))
          return
        }
        const lines = createInterface({ input: child.stdout })
        lines.on("line", (line) => {
          if (!line.startsWith(KEYMAXXER_SIDECAR_URL_PREFIX)) return
          clearTimeout(timeout)
          lines.close()
          resolve(line.slice(KEYMAXXER_SIDECAR_URL_PREFIX.length).trim())
        })
        child.on("exit", (code) => {
          clearTimeout(timeout)
          reject(new Error(`exited early: ${code}`))
        })
      })

      expect(url.startsWith(`http://127.0.0.1:${port}/`)).toBe(true)
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve())
      })
    } finally {
      child.kill("SIGTERM")
    }
  })
})
