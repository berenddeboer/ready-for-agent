import { spawnSync } from "node:child_process"
import { OPENCODE_V2_REQUIRED_OPERATIONS } from "../src/lib/opencode-v2-compatibility.js"
import { describe, expect, it } from "bun:test"

const opencode = spawnSync("opencode", ["--version"], {
  encoding: "utf8",
  timeout: 10_000,
})
const installed = opencode.status === 0

/**
 * OpenAPI operation-name presence only. Endpoint method, body, and header
 * execution lives in the real-CLI contract suite (`opencode:cli-contract`),
 * which calls those endpoints through production launch paths.
 *
 * Fails when OpenCode is installed but discovery or the API contract cannot be
 * confirmed. Does not return early on a failed lookup.
 */
describe.skipIf(!installed)("installed OpenCode V2 API contract", () => {
  it("rejects opencode db path and confirms the session read contract", () => {
    const dbPath = spawnSync("opencode", ["db", "path"], {
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(dbPath.status).not.toBe(0)

    const openapi = spawnSync("opencode", ["api", "get", "/openapi.json"], {
      encoding: "utf8",
      timeout: 20_000,
    })
    const output = `${openapi.stdout ?? ""}\n${openapi.stderr ?? ""}`
    expect(openapi.status, output).toBe(0)
    const spec = JSON.parse(openapi.stdout) as {
      paths?: Record<string, { get?: { operationId?: string } }>
    }
    const operationIds = Object.values(spec.paths ?? {}).flatMap((item) =>
      item.get?.operationId === undefined ? [] : [item.get.operationId],
    )
    for (const operation of OPENCODE_V2_REQUIRED_OPERATIONS) {
      expect(operationIds).toContain(operation)
    }
    expect(spec.paths?.["/api/session/{sessionID}/message"]?.get).toBeDefined()
    expect(spec.paths?.["/api/session"]?.get).toBeDefined()
  })
})
