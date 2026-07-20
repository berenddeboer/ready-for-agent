import {
  defaultKeymaxxerSidecarPort,
  keymaxxerSidecarHost,
  keymaxxerSidecarPortFromEnvironment,
} from "../src/main.js"
import { describe, expect, test } from "bun:test"

describe("Keymaxxer development sidecar", () => {
  test("uses a fixed overridable port and rejects invalid values", () => {
    expect(defaultKeymaxxerSidecarPort).toBe(6057)
    expect(keymaxxerSidecarPortFromEnvironment({})).toBe(
      defaultKeymaxxerSidecarPort,
    )
    expect(
      keymaxxerSidecarPortFromEnvironment({ KEYMAXXER_SIDECAR_PORT: "6042" }),
    ).toBe(6042)
    expect(() =>
      keymaxxerSidecarPortFromEnvironment({ KEYMAXXER_SIDECAR_PORT: "0" }),
    ).toThrow("KEYMAXXER_SIDECAR_PORT")
  })

  test("reports an actionable error when its port is occupied", async () => {
    const occupyingServer = Bun.serve({
      fetch: () => new Response(),
      hostname: keymaxxerSidecarHost,
      port: 0,
    })

    try {
      const sidecar = Bun.spawn(
        [
          process.execPath,
          "--conditions",
          "@ready-for-agent/source",
          new URL("../src/main.ts", import.meta.url).pathname,
        ],
        {
          env: {
            ...process.env,
            KEYMAXXER_SIDECAR_PORT: String(occupyingServer.port),
          },
          stderr: "pipe",
        },
      )

      expect(await sidecar.exited).toBe(1)
      expect(await new Response(sidecar.stderr).text()).toContain(
        `Keymaxxer Sidecar failed to listen on ${keymaxxerSidecarHost}:${occupyingServer.port}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`,
      )
    } finally {
      await occupyingServer.stop(true)
    }
  })
})
