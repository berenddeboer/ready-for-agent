import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendConfigError,
} from "@ready-for-agent/agent-backend"
import { Opencode } from "../src/index.js"
import { buildModelCatalogApiArgs } from "../src/lib/build-args.js"
import {
  OWNED_OPENCODE_SERVER_MISSING_MESSAGE,
  ownedOpenCodeServeArgs,
  selectHarnessOpenCodeConnection,
} from "../src/lib/owned-server.js"
import { describe, expect, it } from "bun:test"

const catalog = JSON.stringify({
  location: { directory: "/work/repo" },
  data: [
    {
      id: "m",
      modelID: "m",
      providerID: "p",
      name: "M",
      enabled: true,
      variants: [],
    },
  ],
})

describe("selectHarnessOpenCodeConnection", () => {
  it("keeps the default connection when Keymaxxer is disabled", () => {
    expect(selectHarnessOpenCodeConnection({ keymaxxerMcpUrl: "  " })).toEqual({
      kind: "default",
    })
    expect(selectHarnessOpenCodeConnection({})).toEqual({ kind: "default" })
  })

  it("keeps an explicit server when Keymaxxer is disabled", () => {
    expect(
      selectHarnessOpenCodeConnection({
        explicitBaseUrl: "http://127.0.0.1:4096",
      }),
    ).toEqual({ kind: "explicit", baseUrl: "http://127.0.0.1:4096" })
  })

  it("uses the owned server when Keymaxxer is enabled and ignores an explicit server", () => {
    expect(
      selectHarnessOpenCodeConnection({
        keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
        ownedBaseUrl: "http://127.0.0.1:43111",
        explicitBaseUrl: "http://127.0.0.1:4096",
      }),
    ).toEqual({ kind: "dedicated", baseUrl: "http://127.0.0.1:43111" })
  })

  it("blocks instead of falling back when the owned server did not start", () => {
    expect(
      selectHarnessOpenCodeConnection({
        keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
        explicitBaseUrl: "http://127.0.0.1:4096",
        startupFailure: "OpenCode exited 1 before it was ready.",
      }),
    ).toEqual({
      kind: "blocked",
      message: "OpenCode exited 1 before it was ready.",
    })
    expect(
      selectHarnessOpenCodeConnection({
        keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
      }),
    ).toEqual({
      kind: "blocked",
      message: OWNED_OPENCODE_SERVER_MISSING_MESSAGE,
    })
  })
})

describe("ownedOpenCodeServeArgs", () => {
  it("starts a private loopback server and does not touch the shared service", () => {
    expect(ownedOpenCodeServeArgs(43111)).toEqual([
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "43111",
    ])
    expect(ownedOpenCodeServeArgs(43111)).not.toContain("--service")
  })
})

describe("buildModelCatalogApiArgs", () => {
  it("pins the catalog read to the worktree directory", () => {
    expect(buildModelCatalogApiArgs({ directory: "/work/repo" })).toEqual([
      "api",
      "--header",
      `x-opencode-directory:${encodeURIComponent("/work/repo")}`,
      "get",
      "/api/model",
    ])
  })
})

describe("Opencode dedicated server routing", () => {
  it("sends model discovery to the owned server instead of standalone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-owned-route-"))
    const binary = join(directory, "opencode")
    const invocation = join(directory, "args")
    const passwordFile = join(directory, "password")
    try {
      await writeFile(
        binary,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" > ${JSON.stringify(invocation)}`,
          `printf '%s' "$OPENCODE_PASSWORD" > ${JSON.stringify(passwordFile)}`,
          'case "$*" in',
          '  *"/api/model"*)',
          `    printf '%s' ${JSON.stringify(catalog)}`,
          "    exit 0",
          "    ;;",
          "esac",
          "exit 1",
          "",
        ].join("\n"),
      )
      await chmod(binary, 0o700)
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          return yield* backend.inspect({
            cwd: directory,
            timeout: "2 seconds",
          })
        }).pipe(
          Effect.provide(
            Opencode.layer({
              binary,
              keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
              dedicatedServer: {
                baseUrl: "http://127.0.0.1:43111",
                password: "owned-password",
                headers: { authorization: "Basic eHh4" },
                assertAvailable: () => undefined,
              },
            }).pipe(Layer.provide(BunServices.layer)),
          ),
        ),
      )
      const args = await Bun.file(invocation).text()
      expect(args.startsWith("api --server http://127.0.0.1:43111 ")).toBe(true)
      expect(args).toContain("/api/model")
      expect(args).toContain(
        `x-opencode-directory:${encodeURIComponent(directory)}`,
      )
      expect(args).not.toContain("--standalone")
      expect(args).not.toContain("owned-password")
      expect(await Bun.file(passwordFile).text()).toBe("owned-password")
      expect(result.models).toEqual([
        { id: "p/m", name: "M", thinkingLevels: [] },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("does not spawn OpenCode when the owned server is blocked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-owned-blocked-"))
    const binary = join(directory, "opencode")
    const invocation = join(directory, "args")
    try {
      await writeFile(
        binary,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" > ${JSON.stringify(invocation)}`,
          "exit 1",
          "",
        ].join("\n"),
      )
      await chmod(binary, 0o700)
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          return yield* backend.inspect({
            cwd: directory,
            timeout: "2 seconds",
          })
        }).pipe(
          Effect.provide(
            Opencode.layer({
              binary,
              keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
              openCodeBlockedReason:
                "Keymaxxer is enabled, but the harness-owned OpenCode server did not become ready.",
            }).pipe(Layer.provide(BunServices.layer)),
          ),
          Effect.flip,
        ),
      )
      expect(error).toBeInstanceOf(AgentBackendConfigError)
      expect(error).toMatchObject({
        message:
          "Keymaxxer is enabled, but the harness-owned OpenCode server did not become ready.",
      })
      expect(await Bun.file(invocation).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
