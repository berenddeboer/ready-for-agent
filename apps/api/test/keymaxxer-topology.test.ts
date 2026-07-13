import { readFile } from "node:fs/promises"
import {
  defaultKeymaxxerSidecarPort,
  keymaxxerSidecarPortFromEnvironment,
} from "../src/keymaxxer-sidecar.js"
import { describe, expect, test } from "bun:test"

describe("API Keymaxxer development topology", () => {
  test("attaches the continuous sidecar only to serve", async () => {
    const project = JSON.parse(
      await readFile(new URL("../project.json", import.meta.url), "utf8"),
    ) as {
      targets: Record<
        string,
        {
          continuous?: boolean
          dependsOn?: unknown[]
          options: { command: string }
        }
      >
    }

    expect(project.targets["keymaxxer-sidecar"]?.continuous).toBe(true)
    expect(project.targets.serve?.dependsOn).toContainEqual({
      projects: "self",
      target: "keymaxxer-sidecar",
    })
    expect(project.targets.serve?.options.command).toContain(
      "KEYMAXXER_SIDECAR_URL",
    )
    expect(project.targets.start?.dependsOn).not.toContainEqual({
      projects: "self",
      target: "keymaxxer-sidecar",
    })
    expect(project.targets.start?.options.command).not.toContain(
      "KEYMAXXER_SIDECAR_URL",
    )
  })

  test("uses a fixed overridable port and rejects invalid values", () => {
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
})
