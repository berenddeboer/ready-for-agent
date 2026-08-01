import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { resolveDefaultDatabasePath } from "../product-data-dir.ts"
import { ApplicationConfig } from "./application-config.ts"

const withConfig = (values: Record<string, string>) =>
  Effect.gen(function* () {
    return yield* ApplicationConfig
  }).pipe(
    Effect.provide(ApplicationConfig.layer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
  )

describe("ApplicationConfig", () => {
  it.effect(
    "loads GraphQL, database, and browser environment through Config",
    () =>
      Effect.gen(function* () {
        const config = yield* withConfig({
          READY_FOR_AGENT_GRAPHQL_URL: "https://example.test/graphql",
          HOME: "/home/operator",
          XDG_DATA_HOME: "/var/operator-data",
          SQLITE_DATABASE_PATH: "/custom/product.db",
          NO_BROWSER: "true",
          PORT: "4300",
        })

        expect(config.graphqlUrl).toBe("https://example.test/graphql")
        expect(config.databasePath).toBe("/custom/product.db")
        expect(config.browserEnv).toEqual({ NO_BROWSER: "true", PORT: "4300" })
      }),
  )

  it.effect("preserves defaults and blank database override semantics", () =>
    Effect.gen(function* () {
      const config = yield* withConfig({
        HOME: "/home/operator",
        SQLITE_DATABASE_PATH: "  ",
      })

      expect(config.graphqlUrl).toBe("http://127.0.0.1:6056/graphql")
      // Match the pure product-path resolver for this host platform (linux /
      // darwin / win32). Platform-specific shapes are covered in
      // product-data-dir.test.ts; this asserts Config wiring only.
      expect(config.databasePath).toBe(
        resolveDefaultDatabasePath({
          env: {
            HOME: "/home/operator",
            SQLITE_DATABASE_PATH: "  ",
          },
          platform: config.platform,
          home: "/home/operator",
        }),
      )
      expect(config.browserEnv.NO_BROWSER).toBeUndefined()
    }),
  )
})
