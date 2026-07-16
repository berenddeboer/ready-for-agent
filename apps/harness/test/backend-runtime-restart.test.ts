import { resolve } from "node:path"
import type { ViteDevServer } from "vite"
import {
  backendRuntimeRestart,
  isBackendRuntimeSource,
} from "../src/server/backend-runtime-restart.js"
import {
  disposeDevelopmentApplication,
  registerDevelopmentApplicationDisposer,
} from "../src/server/development-application.js"
import { afterEach, describe, expect, test } from "bun:test"

const workspaceRoot = resolve(import.meta.dirname, "../../..")

type TestPlugin = {
  readonly configureServer: (server: ViteDevServer) => void
  readonly hotUpdate: (context: { readonly file: string }) => void
  readonly closeBundle: () => Promise<void>
}

const testPlugin = (delay = 1) =>
  backendRuntimeRestart(workspaceRoot, delay) as unknown as TestPlugin

afterEach(async () => {
  await disposeDevelopmentApplication()
})

describe("backend runtime restart", () => {
  test("classifies only runtime-owning Harness and backend package sources", () => {
    expect(
      isBackendRuntimeSource(
        resolve(workspaceRoot, "apps/harness/src/server.ts"),
        workspaceRoot,
      ),
    ).toBe(true)
    expect(
      isBackendRuntimeSource(
        resolve(workspaceRoot, "apps/harness/src/server/job-worker.ts"),
        workspaceRoot,
      ),
    ).toBe(true)
    expect(
      isBackendRuntimeSource(
        resolve(workspaceRoot, "packages/work-item-lifecycle/src/index.ts"),
        workspaceRoot,
      ),
    ).toBe(true)

    expect(
      isBackendRuntimeSource(
        resolve(workspaceRoot, "apps/harness/src/routes/index.tsx"),
        workspaceRoot,
      ),
    ).toBe(false)
    expect(
      isBackendRuntimeSource(
        resolve(workspaceRoot, "packages/graphql-client/src/index.ts"),
        workspaceRoot,
      ),
    ).toBe(false)
  })

  test("coalesces backend edits without restarting for client edits", async () => {
    let restarts = 0
    const plugin = testPlugin()
    plugin.configureServer({
      restart: async () => {
        restarts += 1
      },
      config: { logger: { error: () => undefined } },
      middlewares: { use: () => undefined },
    } as unknown as ViteDevServer)

    plugin.hotUpdate({
      file: resolve(workspaceRoot, "apps/harness/src/routes/index.tsx"),
    })
    plugin.hotUpdate({
      file: resolve(workspaceRoot, "packages/db-service/src/index.ts"),
    })
    plugin.hotUpdate({
      file: resolve(workspaceRoot, "packages/db-service/src/lib/types.ts"),
    })

    await Bun.sleep(10)
    expect(restarts).toBe(1)
  })

  test("disposes the active runtime before restarting Vite", async () => {
    const events: string[] = []
    registerDevelopmentApplicationDisposer(async () => {
      await Bun.sleep(2)
      events.push("disposed")
    })
    const plugin = testPlugin()
    plugin.configureServer({
      restart: async () => {
        events.push("restarted")
      },
      config: { logger: { error: () => undefined } },
      middlewares: { use: () => undefined },
    } as unknown as ViteDevServer)

    plugin.hotUpdate({
      file: resolve(workspaceRoot, "packages/db-service/src/index.ts"),
    })

    await Bun.sleep(10)
    expect(events).toEqual(["disposed", "restarted"])
  })

  test("disposes the application when Vite closes the old server", async () => {
    let disposals = 0
    registerDevelopmentApplicationDisposer(async () => {
      disposals += 1
    })

    const plugin = testPlugin()
    await plugin.closeBundle()
    await plugin.closeBundle()

    expect(disposals).toBe(1)
  })
})
