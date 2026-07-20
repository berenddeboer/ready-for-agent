import { ConfigProvider, Effect } from "effect"
import { ApplicationConfig } from "./application-config.ts"
import { describe, expect, test } from "bun:test"

const loadConfig = (values: Record<string, string>) =>
  Effect.gen(function* () {
    return yield* ApplicationConfig
  }).pipe(
    Effect.provide(ApplicationConfig.layer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
    Effect.runPromise,
  )

describe("ApplicationConfig", () => {
  test("loads GraphQL, database, and browser environment through Config", async () => {
    const config = await loadConfig({
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
  })

  test("preserves defaults and blank database override semantics", async () => {
    const config = await loadConfig({
      HOME: "/home/operator",
      SQLITE_DATABASE_PATH: "  ",
    })

    expect(config.graphqlUrl).toBe("http://127.0.0.1:4200/graphql")
    expect(config.databasePath).toBe(
      config.platform === "darwin"
        ? "/home/operator/Library/Application Support/ready-for-agent/ready-for-agent.db"
        : "/home/operator/.local/share/ready-for-agent/ready-for-agent.db",
    )
    expect(config.browserEnv.NO_BROWSER).toBeUndefined()
  })
})
