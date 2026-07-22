import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { collectChildStdout } from "../src/lib/collect-child-stdout.js"
import { describe, expect, it } from "bun:test"

describe("collectChildStdout", () => {
  it("returns full stdout equal to parsing a >64KB fixture end-to-end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collect-stdout-"))
    const fixturePath = join(directory, "out.txt")
    const binaryPath = join(directory, "writer")
    const body = `${"y".repeat(70_000)}\nlate-marker\n`
    try {
      await writeFile(fixturePath, body)
      await writeFile(
        binaryPath,
        ["#!/bin/sh", `cat "${fixturePath}"`, "exit 0", ""].join("\n"),
      )
      await chmod(binaryPath, 0o700)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const handle = yield* spawner.spawn(
            ChildProcess.make(binaryPath, [], {
              stdin: "ignore",
              stderr: "ignore",
            }),
          )
          return yield* collectChildStdout(handle)
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(body)
      expect(result.stdout.endsWith("late-marker\n")).toBe(true)
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeGreaterThan(
        64 * 1024,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
