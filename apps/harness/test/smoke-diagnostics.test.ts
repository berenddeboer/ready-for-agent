import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { smokeProcessSnapshot } from "../scripts/smoke-diagnostics.ts"
import { describe, expect, test } from "bun:test"

describe("smoke diagnostics", () => {
  test.each([false, true])(
    "preflight lifecycle markers are opt-in (enabled=%s)",
    (enabled) => {
      const runDir = mkdtempSync(join(tmpdir(), "rfa-preflight-diagnostics-"))
      const env = {
        HOME: runDir,
        PATH: "",
        KEYMAXXER_ENABLED: "false",
        SQLITE_DATABASE_PATH: join(runDir, "harness.db"),
        HARNESS_STARTUP_DIAGNOSTICS: enabled ? "1" : "0",
      }
      const options = { env, encoding: "utf8", timeout: 15_000 } as const
      try {
        const migrate = spawnSync(
          process.execPath,
          [
            "--conditions",
            "@ready-for-agent/source",
            fileURLToPath(
              new URL(
                "../../../packages/db/src/bin/migrate.ts",
                import.meta.url,
              ),
            ),
          ],
          options,
        )
        expect(migrate.error).toBeUndefined()
        expect(migrate.status).toBe(0)

        const preflight = spawnSync(
          process.execPath,
          [
            "--conditions",
            "@ready-for-agent/source",
            fileURLToPath(
              new URL("../src/server/preflight.ts", import.meta.url),
            ),
          ],
          options,
        )
        expect(preflight.error).toBeUndefined()
        expect(preflight.status).toBe(0)
        expect(preflight.stdout).toContain(
          "Default Agent Backend 'opencode' is not available",
        )
        const markers = preflight.stdout
          .split("\n")
          .filter((line) => line.startsWith("[preflight "))
        if (enabled) {
          expect(markers.map((line) => line.replace(/^\[.*?\] /, ""))).toEqual([
            "create:start",
            "create:complete",
            "dispose:start",
            "dispose:complete; awaiting process exit",
          ])
          for (const marker of markers) {
            expect(marker).toMatch(
              new RegExp(
                `^\\[preflight pid=${preflight.pid} elapsedMs=\\d+\\]`,
              ),
            )
          }
        } else {
          expect(markers).toEqual([])
        }
      } finally {
        rmSync(runDir, { recursive: true, force: true })
      }
    },
    40_000,
  )

  test("process snapshot identifies the smoke group without arguments or environment", async () => {
    const secret = "smoke-diagnostic-secret-sentinel"
    const child = spawn(
      process.execPath,
      ["--eval", `setInterval(() => {}, 1000); // ${secret}`],
      { detached: true, stdio: "ignore", env: { SECRET: secret } },
    )
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    )
    try {
      expect(child.pid).toBeDefined()
      if (child.pid === undefined)
        throw new Error("Smoke fixture did not spawn")
      const snapshot = smokeProcessSnapshot(child.pid)
      expect(snapshot).toStartWith("PID PPID PGID STAT COMM\n")
      expect(snapshot).toMatch(
        new RegExp(`\\b${child.pid}\\s+${process.pid}\\s+${child.pid}\\s+`),
      )
      expect(snapshot).not.toContain(secret)
      expect(snapshot).not.toContain("--eval")
      for (const line of snapshot.split("\n").slice(1)) {
        expect(line.trim().split(/\s+/)[2]).toBe(String(child.pid))
      }
    } finally {
      child.kill("SIGKILL")
      await exited
    }
  })

  test("an exited process group is explicit", () => {
    expect(smokeProcessSnapshot(2_147_483_647)).toBe(
      "PID PPID PGID STAT COMM\n(smoke process group has exited)",
    )
  })

  test("missing ps reports unavailability without failing or exposing environment", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `import { smokeProcessSnapshot } from ${JSON.stringify(fileURLToPath(new URL("../scripts/smoke-diagnostics.ts", import.meta.url)))}; console.log(smokeProcessSnapshot(process.pid))`,
      ],
      {
        env: { PATH: "/dev/null", SECRET: "smoke-diagnostic-secret-sentinel" },
        encoding: "utf8",
        timeout: 5_000,
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      "Smoke process snapshot unavailable (ps failed or timed out).\n",
    )
    expect(result.stderr).toBe("")
  })
})
