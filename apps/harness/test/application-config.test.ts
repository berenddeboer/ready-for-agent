import { Effect } from "effect"
import {
  loadApplicationConfig,
  loadPort,
} from "../src/server/application-config.js"
import { describe, expect, test } from "bun:test"

describe("harness application config", () => {
  test("loads the Sidecar URL and host tool cwd from the supplied environment", async () => {
    const config = await Effect.runPromise(
      loadApplicationConfig({
        HOME: "/home/operator",
        KEYMAXXER_SIDECAR_URL: " http://127.0.0.1:6057/cap/mcp ",
      }),
    )

    expect(config).toEqual({
      hostToolCwd: "/home/operator",
      keymaxxerSidecarUrl: "http://127.0.0.1:6057/cap/mcp",
    })
  })

  test("allows Keymaxxer to be explicitly disabled", async () => {
    const config = await Effect.runPromise(
      loadApplicationConfig({
        HOME: "/home/operator",
        KEYMAXXER_ENABLED: "false",
      }),
    )

    expect(config.keymaxxerSidecarUrl).toBeUndefined()
  })

  test("rejects an enabled configuration without a Sidecar URL", async () => {
    const exit = await Effect.runPromise(Effect.exit(loadApplicationConfig({})))
    expect(exit._tag).toBe("Failure")
  })

  test("loads and validates the production port", async () => {
    expect(await Effect.runPromise(loadPort({}))).toBe(6056)
    expect(await Effect.runPromise(loadPort({ PORT: "4300" }))).toBe(4300)

    for (const value of ["0", "1.5", "65536", "not-a-port"]) {
      const exit = await Effect.runPromise(
        Effect.exit(loadPort({ PORT: value })),
      )
      expect(exit._tag).toBe("Failure")
    }
  })
})
