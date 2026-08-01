import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  loadApplicationConfig,
  loadPort,
} from "../src/server/application-config.js"

describe("harness application config", () => {
  it.effect(
    "loads the Sidecar URL and host tool cwd from the supplied environment",
    () =>
      Effect.gen(function* () {
        const config = yield* loadApplicationConfig({
          HOME: "/home/operator",
          KEYMAXXER_SIDECAR_URL: " http://127.0.0.1:6057/cap/mcp ",
        })

        expect(config).toEqual({
          hostToolCwd: "/home/operator",
          keymaxxerSidecarUrl: "http://127.0.0.1:6057/cap/mcp",
        })
      }),
  )

  it.effect("allows Keymaxxer to be explicitly disabled", () =>
    Effect.gen(function* () {
      const config = yield* loadApplicationConfig({
        HOME: "/home/operator",
        KEYMAXXER_ENABLED: "false",
      })

      expect(config.keymaxxerSidecarUrl).toBeUndefined()
    }),
  )

  it.effect("rejects an enabled configuration without a Sidecar URL", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(loadApplicationConfig({}))
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("loads and validates the production port", () =>
    Effect.gen(function* () {
      expect(yield* loadPort({})).toBe(6056)
      expect(yield* loadPort({ PORT: "4300" })).toBe(4300)

      for (const value of ["0", "1.5", "65536", "not-a-port"]) {
        const exit = yield* Effect.exit(loadPort({ PORT: value }))
        expect(exit._tag).toBe("Failure")
      }
    }),
  )
})
