import { spawnSync } from "node:child_process"
import { buildCommandApiArgs, buildRunArgs } from "../src/lib/build-args.js"
import { describe, expect, it } from "bun:test"

const opencode = spawnSync("opencode", ["--version"], { encoding: "utf8" })

/** Flags only. Tokens after `--` are message text, so a probe flag must precede them. */
const flagsOnly = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const end = args.indexOf("--")
  return end === -1 ? args : args.slice(0, end)
}

const rejectBeforeInference = (args: ReadonlyArray<string>) =>
  spawnSync("opencode", [...flagsOnly(args), "--bogus"], {
    encoding: "utf8",
    timeout: 10_000,
  })

describe.skipIf(opencode.status !== 0)(
  "installed OpenCode V2 argument contract",
  () => {
    it("accepts generated start and resume argv and rejects obsolete flags before inference", () => {
      const start = buildRunArgs({
        prompt: "fix the bug",
        model: "provider/model",
        thinkingLevel: "high",
      })
      const resume = buildRunArgs({
        prompt: "continue",
        model: "provider/model",
        thinkingLevel: null,
        sessionId: "ses_contract",
      })
      const command = buildCommandApiArgs({
        sessionId: "ses_contract",
        command: "/review",
        prompt: "Review the diff",
        directory: "/tmp/work-item",
      })

      for (const args of [start, resume, command.args]) {
        expect(flagsOnly(args)).not.toContain("--")
        const result = rejectBeforeInference(args)
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        expect(result.status).toBe(1)
        expect(output).toContain("Unrecognized flag: --bogus")
        expect(output).not.toContain("Unrecognized flag: --dir")
        expect(output).not.toContain("Unrecognized flag: --variant")
        expect(output).not.toContain("Unrecognized flag: --command")
      }

      const obsolete = spawnSync(
        "opencode",
        ["run", "--dir", "/tmp", "--variant", "high"],
        { encoding: "utf8", timeout: 10_000 },
      )
      const obsoleteOutput = `${obsolete.stdout ?? ""}\n${obsolete.stderr ?? ""}`
      expect(obsolete.status).toBe(1)
      expect(obsoleteOutput).toContain("Unrecognized flag: --dir")
      expect(obsoleteOutput).toContain("Unrecognized flag: --variant")
    })
  },
)
