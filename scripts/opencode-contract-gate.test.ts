import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classifyOpenCodeContract,
  gateOpenCodeContract,
  readOpenCodeBaseline,
} from "./opencode-contract-gate.ts"
import {
  EXPECTED_OPENCODE_CLI_CONTRACT_CASES,
  parseSuiteCounts,
  redactContractText,
  runOpenCodeCliContract,
} from "./run-opencode-cli-contract.ts"
import { describe, expect, it } from "bun:test"

const BASELINE = "2.0.32"

const writeFake = (script: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-gate-"))
  const binary = join(directory, "opencode")
  writeFileSync(binary, script)
  chmodSync(binary, 0o755)
  return directory
}

describe("OpenCode contract version gate", () => {
  it("reads the supported baseline from mise.toml", () => {
    expect(readOpenCodeBaseline(`OPENCODE_V2_BASELINE = "${BASELINE}"\n`)).toBe(
      BASELINE,
    )
    expect(readOpenCodeBaseline('bun = "1.4.3"\n')).toBeUndefined()
  })

  it("fails when the executable is missing", () => {
    const gate = classifyOpenCodeContract({
      mode: "baseline",
      baseline: BASELINE,
      binary: undefined,
    })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.reason).toBe("missing-executable")
      expect(gate.message).toContain("missing")
      expect(gate.message).toContain(BASELINE)
    }
  })

  it("fails when the version probe fails", () => {
    const gate = classifyOpenCodeContract({
      mode: "baseline",
      baseline: BASELINE,
      binary: "/tmp/opencode-missing-probe",
      probe: {
        status: 1,
        stdout: "",
        stderr: "installer failed",
      },
    })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.reason).toBe("probe-failed")
      expect(gate.message).toContain("probe failed")
    }
  })

  it("fails V1 as the wrong major", () => {
    const gate = classifyOpenCodeContract({
      mode: "baseline",
      baseline: BASELINE,
      binary: "/opt/opencode",
      probe: { status: 0, stdout: "1.18.31\n", stderr: "" },
    })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.reason).toBe("wrong-major")
      expect(gate.message).toContain("major 1")
      expect(gate.message).toContain("1.18.31")
    }
  })

  it("fails a different V2 in baseline mode and accepts it as drift", () => {
    const probe = {
      status: 0,
      stdout: "opencode v2.9.0\n",
      stderr: "",
    }
    const baseline = classifyOpenCodeContract({
      mode: "baseline",
      baseline: BASELINE,
      binary: "/opt/opencode",
      probe,
    })
    expect(baseline.ok).toBe(false)
    if (!baseline.ok) {
      expect(baseline.reason).toBe("unsupported-version")
      expect(baseline.message).toContain("2.9.0")
      expect(baseline.message).toContain(BASELINE)
    }

    const latest = classifyOpenCodeContract({
      mode: "latest",
      baseline: BASELINE,
      binary: "/opt/opencode",
      probe,
    })
    expect(latest.ok).toBe(true)
    if (latest.ok) {
      expect(latest.version).toBe("2.9.0")
      expect(latest.mode).toBe("latest")
    }
  })

  it("accepts the pinned baseline and rejects an invalid mode", () => {
    const accepted = classifyOpenCodeContract({
      mode: undefined,
      baseline: BASELINE,
      binary: "/opt/opencode",
      probe: { status: 0, stdout: "opencode v2.0.32\n", stderr: "" },
    })
    expect(accepted.ok).toBe(true)
    if (accepted.ok) {
      expect(accepted.mode).toBe("baseline")
      expect(accepted.version).toBe(BASELINE)
    }

    const invalid = classifyOpenCodeContract({
      mode: "skip",
      baseline: BASELINE,
      binary: "/opt/opencode",
      probe: { status: 0, stdout: "opencode v2.0.32\n", stderr: "" },
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.reason).toBe("invalid-mode")
    }
  })

  it("fails a live missing PATH and a live V1 binary", async () => {
    const empty = mkdtempSync(join(tmpdir(), "opencode-empty-"))
    const missing = gateOpenCodeContract({
      mode: "baseline",
      pathEnv: empty,
      baseline: BASELINE,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.reason).toBe("missing-executable")
    }

    const v1 = writeFake("#!/bin/sh\nprintf '%s\\n' '1.18.31'\n")
    try {
      const wrongMajor = gateOpenCodeContract({
        mode: "baseline",
        pathEnv: v1,
        baseline: BASELINE,
      })
      expect(wrongMajor.ok).toBe(false)
      if (!wrongMajor.ok) {
        expect(wrongMajor.reason).toBe("wrong-major")
      }

      const requiredJob = await runOpenCodeCliContract({
        mode: "baseline",
        pathEnv: v1,
      })
      expect(requiredJob.status).not.toBe(0)
      expect(requiredJob.message).toContain("major 1")
      expect(requiredJob.message).not.toContain(" pass")
    } finally {
      rmSync(v1, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("fails the required-job entry when PATH has no opencode", async () => {
    const empty = mkdtempSync(join(tmpdir(), "opencode-empty-"))
    try {
      const result = await runOpenCodeCliContract({
        mode: "baseline",
        pathEnv: empty,
      })
      expect(result.status).not.toBe(0)
      expect(result.message).toContain("missing")
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("rejects an all-skipped suite count and redacts secrets", () => {
    expect(parseSuiteCounts(" 0 pass\n 11 skip\n 0 fail\n")).toEqual({
      pass: 0,
      fail: 0,
      skip: 11,
    })
    expect(parseSuiteCounts(" 11 pass\n 0 fail\n")).toEqual({
      pass: 11,
      fail: 0,
      skip: 0,
    })
    expect(
      parseSuiteCounts(
        "\u001b[32m 10 pass\u001b[0m\n\u001b[2m 0 fail\u001b[0m\n",
      ),
    ).toEqual({
      pass: 10,
      fail: 0,
      skip: 0,
    })
    expect(redactContractText("token=supersecret", ["supersecret"])).toBe(
      "token=[redacted]",
    )
    expect(EXPECTED_OPENCODE_CLI_CONTRACT_CASES).toBe(11)
  })

  it("installs the baseline pin without calling the network", () => {
    const result = spawnSync(
      "bash",
      [join(import.meta.dir, "install-opencode-v2.sh"), "baseline"],
      {
        encoding: "utf8",
        env: { ...process.env, OPENCODE_INSTALL_DRY_RUN: "1" },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `[opencode-install] mode=baseline version=${BASELINE}`,
    )
  })
})
