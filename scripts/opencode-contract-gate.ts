/**
 * Fail closed before OpenCode command-contract tests.
 *
 * Required CI calls this through `opencode:cli-contract`. A missing binary,
 * a failed probe, a wrong major, or a version other than the baseline must
 * fail the job. It must not skip the suite.
 */
import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"

const OPENCODE_BASELINE_KEY = "OPENCODE_V2_BASELINE"

type OpenCodeContractMode = "baseline" | "latest"

type OpenCodeContractFailureReason =
  | "missing-executable"
  | "probe-failed"
  | "wrong-major"
  | "unsupported-version"
  | "invalid-mode"
  | "baseline-unreadable"

export type OpenCodeContractGate =
  | {
      readonly ok: true
      readonly mode: OpenCodeContractMode
      readonly baseline: string
      readonly binary: string
      readonly version: string
      readonly versionLine: string
    }
  | {
      readonly ok: false
      readonly reason: OpenCodeContractFailureReason
      readonly message: string
      readonly baseline: string
      readonly binary?: string
      readonly version?: string
    }

export type VersionProbe = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

const VERSION = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?!\d)/

export const workspaceRoot = join(import.meta.dir, "..")

export const readOpenCodeBaseline = (miseToml: string): string | undefined =>
  miseToml.match(
    new RegExp(`^${OPENCODE_BASELINE_KEY}\\s*=\\s*"([^"]+)"`, "m"),
  )?.[1]

const parseOpenCodeVersion = (text: string): string | undefined => {
  const match = VERSION.exec(text)
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined
  }
  return `${match[1]}.${match[2]}.${match[3]}`
}

const majorOf = (version: string): number => Number(version.split(".")[0])

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? text.trim()

const fail = (
  reason: OpenCodeContractFailureReason,
  message: string,
  baseline: string,
  extra?: { readonly binary?: string; readonly version?: string },
): OpenCodeContractGate => ({
  ok: false,
  reason,
  message,
  baseline,
  ...extra,
})

export const classifyOpenCodeContract = (input: {
  readonly mode: string | undefined
  readonly baseline: string | undefined
  readonly binary: string | undefined
  readonly probe?: VersionProbe
}): OpenCodeContractGate => {
  const baseline = input.baseline ?? ""
  if (!/^\d+\.\d+\.\d+$/.test(baseline)) {
    return fail(
      "baseline-unreadable",
      `mise.toml is missing ${OPENCODE_BASELINE_KEY}. Required coverage has no supported OpenCode version to install and test.`,
      baseline,
    )
  }

  const mode = input.mode ?? "baseline"
  if (mode !== "baseline" && mode !== "latest") {
    return fail(
      "invalid-mode",
      `OPENCODE_CONTRACT_MODE=${mode} is not baseline or latest. Refusing to run the contract suite.`,
      baseline,
    )
  }

  if (input.binary === undefined) {
    return fail(
      "missing-executable",
      `OpenCode executable is missing. Required baseline is ${baseline}. Install it with bash scripts/install-opencode-v2.sh baseline and put it on PATH, then rerun bunx nx run opencode:cli-contract.`,
      baseline,
    )
  }

  const probe = input.probe
  const output = `${probe?.stdout ?? ""}\n${probe?.stderr ?? ""}`.trim()
  if (
    probe === undefined ||
    probe.error !== undefined ||
    probe.status !== 0 ||
    output.length === 0
  ) {
    const detail = probe?.error ?? output.slice(0, 200)
    return fail(
      "probe-failed",
      `OpenCode version probe failed for ${input.binary} (exit ${String(probe?.status ?? "none")}). ${detail || "No output."} Reinstall the supported baseline ${baseline}.`,
      baseline,
      { binary: input.binary },
    )
  }

  const version = parseOpenCodeVersion(output)
  if (version === undefined) {
    return fail(
      "probe-failed",
      `OpenCode version probe failed for ${input.binary}: could not parse a version from ${output.slice(0, 200)}. Reinstall the supported baseline ${baseline}.`,
      baseline,
      { binary: input.binary },
    )
  }

  const major = majorOf(version)
  if (major !== 2) {
    return fail(
      "wrong-major",
      `OpenCode major ${String(major)} is not supported (resolved ${input.binary} version ${version}). Required CI accepts only OpenCode 2, baseline ${baseline}.`,
      baseline,
      { binary: input.binary, version },
    )
  }

  if (mode === "baseline" && version !== baseline) {
    return fail(
      "unsupported-version",
      `OpenCode ${version} is not the supported baseline ${baseline} (resolved ${input.binary}). Required coverage installs and tests ${baseline}. Scheduled drift coverage uses OPENCODE_CONTRACT_MODE=latest.`,
      baseline,
      { binary: input.binary, version },
    )
  }

  return {
    ok: true,
    mode,
    baseline,
    binary: input.binary,
    version,
    versionLine: firstLine(output),
  }
}

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const resolveOpenCodeExecutable = (pathEnv: string): string | undefined => {
  for (const directory of pathEnv.split(delimiter)) {
    if (directory.length === 0) {
      continue
    }
    const candidate = join(directory, "opencode")
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return undefined
}

const probeVersion = (binary: string): VersionProbe => {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error.message }),
  }
}

export const gateOpenCodeContract = (options?: {
  readonly mode?: string
  readonly pathEnv?: string
  readonly baseline?: string
  readonly miseToml?: string
}): OpenCodeContractGate => {
  const miseToml =
    options?.miseToml ?? readFileSync(join(workspaceRoot, "mise.toml"), "utf8")
  const baseline = options?.baseline ?? readOpenCodeBaseline(miseToml)
  const pathEnv = options?.pathEnv ?? process.env.PATH ?? ""
  const binary = resolveOpenCodeExecutable(pathEnv)
  const probe = binary === undefined ? undefined : probeVersion(binary)
  return classifyOpenCodeContract({
    mode: options?.mode ?? process.env.OPENCODE_CONTRACT_MODE,
    baseline,
    binary,
    ...(probe === undefined ? {} : { probe }),
  })
}

export const formatGateLog = (gate: OpenCodeContractGate): string => {
  if (!gate.ok) {
    return `[opencode-cli-contract] gate=${gate.reason} baseline=${gate.baseline} ${gate.message}`
  }
  const identity = `[opencode-cli-contract] mode=${gate.mode} baseline=${gate.baseline} binary=${gate.binary} version=${gate.version}`
  if (gate.mode === "latest") {
    return `${identity}\n[opencode-cli-contract] drift coverage runs latest stable V2 against the baseline pin. A contract failure here is upstream drift, not a pin mismatch.`
  }
  return identity
}
