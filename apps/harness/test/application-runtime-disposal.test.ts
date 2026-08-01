import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { DatabaseLive, runConfiguredMigrations } from "@ready-for-agent/db"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import type { KeymaxxerToolClient } from "@ready-for-agent/keymaxxer-service"
import { createApplication } from "../src/server/application.server.js"
import { environmentConfigLayer } from "../src/server/application-config.js"

// Migrations + createApplication + dispose can exceed the default under load.
// Bound higher than default via vitest options.
describe("application runtime disposal", () => {
  it.live(
    "application disposal closes a lazily created authentication client",
    () =>
      Effect.gen(function* () {
        // Scope finalizer always removes the temp dir (unlike try/finally + yield*).
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "rfa-auth-runtime-"))),
          (dir) =>
            Effect.promise(() => rm(dir, { recursive: true, force: true })),
        )
        const environment = {
          HOME: directory,
          KEYMAXXER_SIDECAR_URL:
            "http://127.0.0.1:6057/application-runtime/mcp",
          SQLITE_DATABASE_PATH: join(directory, "ready-for-agent.db"),
        }
        const configLayer = environmentConfigLayer(environment)
        let application:
          | Awaited<ReturnType<typeof createApplication>>
          | undefined
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

        yield* Effect.gen(function* () {
          yield* runConfiguredMigrations().pipe(
            Effect.provide(DatabaseLive.pipe(Layer.provide(configLayer))),
          )
          const databaseLayer = DbServiceLive.pipe(
            Layer.provideMerge(DatabaseLive),
            Layer.provide(configLayer),
          )
          yield* Effect.gen(function* () {
            const db = yield* DbService
            yield* db.addRepository({
              forge: "github",
              forgeHost: "github.com",
              projectPath: "acme/widgets",
              localPath: join(directory, "widgets"),
              isBare: true,
            })
          }).pipe(Effect.provide(databaseLayer))

          application = yield* Effect.promise(() =>
            createApplication(environment, {
              startWorker: false,
              sidecarLayerOptions: {
                createClient: async () => client,
                fetch: async () => new Response(null, { status: 404 }),
              },
            }),
          )
          const response = yield* Effect.promise(() =>
            application!.context.graphqlApi.fetch(
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
            ),
          )

          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            data: {
              repositoryCredentials: [{ configured: true }],
            },
          })
          expect(closeCalls).toBe(0)

          yield* Effect.promise(() => application!.dispose())
          disposed = true
          expect(closeCalls).toBe(1)
        }).pipe(
          // Always dispose a half-built application if the body fails mid-way.
          Effect.ensuring(
            Effect.suspend(() =>
              application !== undefined && !disposed
                ? Effect.promise(() => application!.dispose())
                : Effect.void,
            ),
          ),
        )
      }),
    15_000,
  )
})
