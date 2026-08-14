import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  ActiveAgentBackendLive,
  type ResolveAgentBackendRuntime,
  getBuiltInAgentBackend,
  runCliCapture,
  sanitizeInheritedEnvironment,
  unsupportedSessionTelemetry,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "agent-backend-inspect-"))
  const path = join(directory, "fake-cli")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const resolveCaptureRuntime =
  (binary: string): ResolveAgentBackendRuntime =>
  (backendId) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const found = getBuiltInAgentBackend(backendId)
      if (found === undefined) {
        throw new Error(`missing registration ${backendId}`)
      }
      return {
        registration: found,
        adapter: {
          inspect: (input) =>
            runCliCapture({
              spawner,
              backend: found.descriptor,
              binary,
              args: [],
              cwd: input.cwd,
              env: sanitizeInheritedEnvironment(),
              timeout: input.timeout ?? Duration.seconds(2),
            }).pipe(
              Effect.map(() => ({
                backend: found.descriptor,
                models: [],
              })),
            ),
          startTurn: () =>
            Effect.die("startTurn is not part of this inspect fixture"),
          continueTurn: () =>
            Effect.die("continueTurn is not part of this inspect fixture"),
        },
        telemetry: {
          getSession: (sessionId: string) =>
            Effect.succeed(
              unsupportedSessionTelemetry(sessionId, found.descriptor),
            ),
        },
      }
    })

describe("Preview and Recheck inspect stderr", () => {
  it("propagates a stderr-only child failure as the Unavailable reason", async () => {
    await withExecutable(
      [
        "printf 'Error: Configuration is invalid at /home/vscode/.config/opencode/opencode.jsonc\\n' >&2",
        "printf '↳ Expected object | undefined, got [ … ] skills\\n' >&2",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const layer = ActiveAgentBackendLive({
          selectedBackendId: AGENT_BACKEND_IDS.opencode,
          resolveRuntime: resolveCaptureRuntime(binary),
        }).pipe(Layer.provide(BunServices.layer))

        await Effect.runPromise(
          Effect.gen(function* () {
            const active = yield* ActiveAgentBackend
            const preview = yield* active.preview(AGENT_BACKEND_IDS.opencode, {
              cwd: process.cwd(),
            })
            const recheck = yield* active.recheck(AGENT_BACKEND_IDS.opencode, {
              cwd: process.cwd(),
            })

            expect(preview.kind).toBe("unavailable")
            expect(preview.reason).toContain(
              "Configuration is invalid at /home/vscode/.config/opencode/opencode.jsonc",
            )
            expect(preview.reason).toContain("skills")
            expect(preview.reason).not.toBe(
              "Agent Backend inspection failed (AgentBackendExitError)",
            )

            expect(recheck.kind).toBe("unavailable")
            expect(recheck.reason).toBe(preview.reason)
          }).pipe(Effect.provide(layer)),
        )
      },
    )
  })
})
