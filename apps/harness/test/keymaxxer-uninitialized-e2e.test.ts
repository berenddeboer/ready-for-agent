/**
 * Live e2e for Keymaxxer soft-disable when the operator never initialized a
 * vault (issue #1195). Does **not** set KEYMAXXER_ENABLED=false — that is the
 * current hole this suite exists to close. Workspace/stub `keymaxxer` stays
 * on PATH; HOME has no vault; at least one Repository is seeded so Auto-heal
 * would call list if Keymaxxer were wrongly enabled.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { Effect, Layer } from "effect"
import { DatabaseLive, runConfiguredMigrations } from "@ready-for-agent/db"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { isKeymaxxerAvailable } from "@ready-for-agent/keymaxxer-service"
import { pathWithoutBinaries } from "../e2e/support/agent-backend-path.ts"
import { createApplication } from "../src/server/application.server.ts"
import { environmentConfigLayer } from "../src/server/application-config.ts"
import {
  type Application,
  type ProductionLifecycleEvent,
  resolveKeymaxxerMode,
  startProductionLifecycle,
} from "../src/server/production-lifecycle.ts"
import { afterEach, describe, expect, test } from "bun:test"

const AUTO_HEAL_FAILURE = "Polling Auto-heal Job failed"
const LIST_FAILURE = "Keymaxxer list failed"

const graphqlHealth = async (application: Application): Promise<boolean> => {
  const response = await application.context.graphqlApi.fetch(
    new Request("http://127.0.0.1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { health }" }),
    }),
  )
  if (!response.ok) {
    return false
  }
  const payload = (await response.json()) as {
    data?: { health?: boolean }
  }
  return payload.data?.health === true
}

describe("Keymaxxer uninitialized operator path", () => {
  let runDir: string | undefined

  afterEach(async () => {
    if (runDir !== undefined) {
      await rm(runDir, { recursive: true, force: true })
      runDir = undefined
    }
  })

  test("workspace keymaxxer without a vault soft-disables and Auto-heal stays silent", async () => {
    runDir = mkdtempSync(join(tmpdir(), "rfa-keymaxxer-uninitialized-"))
    const home = join(runDir, "home")
    const binDir = join(runDir, "bin")
    const dbPath = join(runDir, "harness.db")
    mkdirSync(home, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(binDir, "keymaxxer"),
      `#!/bin/sh
echo "keymaxxer: no vault found. Run \`keymaxxer init\` first." >&2
exit 1
`,
    )
    chmodSync(join(binDir, "keymaxxer"), 0o755)

    const productPath = `${binDir}${delimiter}${pathWithoutBinaries(process.env.PATH ?? "", ["keymaxxer"])}`
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: productPath,
      SQLITE_DATABASE_PATH: dbPath,
      NO_BROWSER: "1",
    }
    for (const key of [
      "KEYMAXXER_ENABLED",
      "KEYMAXXER_SIDECAR_URL",
      "KEYMAXXER_ENTRYPOINT",
      "KEYMAXXER_DB_DIR",
      "XDG_CONFIG_HOME",
      "KEYMAXXER_MASTER_KEY",
      "E2E_KEYMAXXER_MASTER_KEY",
    ]) {
      delete environment[key]
    }

    expect(Bun.which("keymaxxer", { PATH: productPath })).toBe(
      join(binDir, "keymaxxer"),
    )
    expect(isKeymaxxerAvailable(environment)).toBe(false)
    expect(resolveKeymaxxerMode(environment)).toEqual({ kind: "disabled" })

    const events: ProductionLifecycleEvent[] = []
    const logs: string[] = []
    let application: Application | undefined
    let applicationEnv: NodeJS.ProcessEnv | undefined

    const pushLog = (value: unknown) => {
      logs.push(typeof value === "string" ? value : String(value))
    }
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    }
    console.log = (...args: unknown[]) => {
      args.forEach(pushLog)
      original.log.apply(console, args)
    }
    console.info = (...args: unknown[]) => {
      args.forEach(pushLog)
      original.info.apply(console, args)
    }
    console.warn = (...args: unknown[]) => {
      args.forEach(pushLog)
      original.warn.apply(console, args)
    }
    console.error = (...args: unknown[]) => {
      args.forEach(pushLog)
      original.error.apply(console, args)
    }

    const configLayer = environmentConfigLayer(environment)
    try {
      const handle = await startProductionLifecycle({
        waitForShutdown: false,
        environment,
        argv: ["bun", "server.ts", "--no-open"],
        applyMigrations: async () => {
          await Effect.runPromise(
            runConfiguredMigrations().pipe(
              Effect.provide(DatabaseLive.pipe(Layer.provide(configLayer))),
            ),
          )
          const databaseLayer = DbServiceLive.pipe(
            Layer.provideMerge(DatabaseLive),
            Layer.provide(configLayer),
          )
          await Effect.runPromise(
            Effect.gen(function* () {
              const db = yield* DbService
              yield* db.addRepository({
                forge: "github",
                forgeHost: "github.com",
                projectPath: "acme/widgets",
                localPath: join(home, "widgets.git"),
                isBare: true,
              })
            }).pipe(Effect.provide(databaseLayer)),
          )
        },
        createApplication: async (applicationEnvironment) => {
          applicationEnv = { ...applicationEnvironment }
          application = await createApplication(applicationEnvironment)
          return application
        },
        loadStartHandler: async () => ({
          fetch: async () => new Response("handler"),
        }),
        serveHttp: async () => ({
          port: 4242,
          stop: async () => {},
        }),
        openBrowser: () => {},
        onEvent: (event) => {
          events.push(event)
        },
        logInfo: pushLog,
        logError: pushLog,
      })

      expect(applicationEnv?.KEYMAXXER_ENABLED).toBe("false")
      expect(applicationEnv?.KEYMAXXER_SIDECAR_URL).toBeUndefined()
      expect(events).not.toContain("sidecar-ready")
      expect(events).toContain("application-ready")
      if (application === undefined) {
        throw new Error("createApplication did not return an Application")
      }
      const started = application

      const healthDeadline = Date.now() + 15_000
      let healthy = false
      while (Date.now() < healthDeadline) {
        healthy = await graphqlHealth(started)
        if (healthy) {
          break
        }
        await Bun.sleep(200)
      }
      expect(healthy).toBe(true)

      // Auto-heal is forked at application start; give it a beat to fail
      // closed if Keymaxxer were still wrongly enabled.
      await Bun.sleep(1_500)
      const combined = logs.join("\n")
      expect(combined).not.toContain(AUTO_HEAL_FAILURE)
      expect(combined).not.toContain(LIST_FAILURE)

      await handle.dispose()
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
    }
  }, 120_000)
})
