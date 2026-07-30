import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { DatabaseLive, runConfiguredMigrations } from "@ready-for-agent/db"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import type { KeymaxxerToolClient } from "@ready-for-agent/keymaxxer-service"
import { createApplication } from "../src/server/application.server.js"
import { environmentConfigLayer } from "../src/server/application-config.js"
import { expect, test } from "bun:test"

// Migrations + createApplication + dispose can exceed Bun's 5s default under
// nx affected --batch load (observed ~5.2s flake). Bound higher than default.
test(
  "application disposal closes a lazily created authentication client",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfa-auth-runtime-"))
    const environment = {
      HOME: directory,
      KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/application-runtime/mcp",
      SQLITE_DATABASE_PATH: join(directory, "ready-for-agent.db"),
    }
    const configLayer = environmentConfigLayer(environment)
    let application: Awaited<ReturnType<typeof createApplication>> | undefined
    let disposed = false
    let closeCalls = 0
    const client: KeymaxxerToolClient = {
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                name: "GITHUB_TOKEN_ACME_WIDGETS",
                provider: "github",
                account: "acme/widgets",
              },
            ]),
          },
        ],
      }),
      close: async () => {
        closeCalls += 1
      },
    }

    try {
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
            localPath: join(directory, "widgets"),
            isBare: true,
          })
        }).pipe(Effect.provide(databaseLayer)),
      )

      application = await createApplication(environment, {
        startWorker: false,
        sidecarLayerOptions: {
          createClient: async () => client,
          fetch: async () => new Response(null, { status: 404 }),
        },
      })
      const response = await application.context.graphqlApi.fetch(
        new Request("http://127.0.0.1:6056/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `query {
            repositoryCredentials {
              configured
              repositoryId
            }
          }`,
          }),
        }),
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        data: {
          repositoryCredentials: [{ configured: true }],
        },
      })
      expect(closeCalls).toBe(0)

      await application.dispose()
      disposed = true
      expect(closeCalls).toBe(1)
    } finally {
      if (application !== undefined && !disposed) {
        await application.dispose()
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
  { timeout: 15_000 },
)
