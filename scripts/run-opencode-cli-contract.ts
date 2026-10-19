/**
 * Nx entry for `opencode:cli-contract`.
 *
 * Gates the resolved OpenCode binary, then runs the production-path suite.
 * An empty or skipped run is a failure even when the test runner exits 0.
 */
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type OpenCodeContractGate,
  formatGateLog,
  gateOpenCodeContract,
  workspaceRoot,
} from "./opencode-contract-gate.ts"

/** Passing cases in the two real-CLI files. Not a skip allowance. */
export const EXPECTED_OPENCODE_CLI_CONTRACT_CASES = 11

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i

type SuiteCounts = {
  readonly pass: number
  readonly fail: number
  readonly skip: number
}

type RunResult = {
  readonly status: number
  readonly message: string
}

const diagnosticsDir = (): string =>
  process.env.OPENCODE_CONTRACT_DIAGNOSTICS_DIR ??
  join(workspaceRoot, "tmp", "opencode-cli-contract")

const secretValues = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const values: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      value.length >= 8 &&
      SECRET_NAME.test(name) &&
      name !== "OPENCODE_CONTRACT_DIAGNOSTICS_DIR"
    ) {
      values.push(value)
    }
  }
  return values
}

export const redactContractText = (
  text: string,
  secrets: ReadonlyArray<string>,
): string => {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]")
    }
  }
  return redacted
}

const stripAnsi = (text: string): string => {
  const ansiEscape = String.fromCharCode(27)
  return text.split(ansiEscape).reduce((acc, chunk, index) => {
    if (index === 0) {
      return chunk
    }
    return acc + chunk.replace(/^\[[0-9;]*m/, "")
  }, "")
}

const countLine = (output: string, label: string): number => {
  const matches = [
    ...stripAnsi(output).matchAll(
      new RegExp(`^\\s*(\\d+)\\s+${label}\\s*$`, "gm"),
    ),
  ]
  const last = matches.at(-1)?.[1]
  return last === undefined ? 0 : Number(last)
}

export const parseSuiteCounts = (output: string): SuiteCounts => ({
  pass: countLine(output, "pass"),
  fail: countLine(output, "fail"),
  skip: countLine(output, "skip"),
})

const writeSummary = (markdown: string): void => {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path === undefined || path.length === 0) {
    return
  }
  appendFileSync(path, markdown)
}

const childEnv = (
  parent: NodeJS.ProcessEnv,
  pathEnv: string | undefined,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...parent }
  if (pathEnv !== undefined) {
    env.PATH = pathEnv
  }
  for (const name of Object.keys(env)) {
    if (SECRET_NAME.test(name)) {
      delete env[name]
    }
  }
  return env
}

const runBun = (
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly status: number; readonly output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", [...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8")
      output += text
      process.stdout.write(text)
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.on("error", reject)
    child.on("close", (status) => {
      resolve({ status: status ?? 1, output })
    })
  })

const record = (
  directory: string,
  gate: OpenCodeContractGate,
  extra?: string,
): void => {
  mkdirSync(directory, { recursive: true })
  const lines = [formatGateLog(gate)]
  if (extra !== undefined) {
    lines.push(extra)
  }
  writeFileSync(join(directory, "version.txt"), `${lines.join("\n")}\n`)
}

export const runOpenCodeCliContract = async (options?: {
  readonly mode?: string
  readonly pathEnv?: string
}): Promise<RunResult> => {
  const directory = diagnosticsDir()
  const secrets = secretValues(process.env)
  const gate = gateOpenCodeContract({
    ...(options?.mode === undefined ? {} : { mode: options.mode }),
    ...(options?.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
  })
  const log = redactContractText(formatGateLog(gate), secrets)
  console.log(log)
  record(directory, gate)

  if (!gate.ok) {
    writeFileSync(join(directory, "failure.txt"), `${log}\n`)
    writeSummary(`## OpenCode CLI contract\n\n${log}\n`)
    return { status: 1, message: log }
  }

  writeSummary(
    [
      "## OpenCode CLI contract",
      "",
      `- mode: \`${gate.mode}\``,
      `- baseline: \`${gate.baseline}\``,
      `- resolved: \`${gate.version}\``,
      `- binary: \`${gate.binary}\``,
      "",
    ].join("\n"),
  )

  const env = childEnv(process.env, options?.pathEnv)
  const opencodeRoot = join(workspaceRoot, "packages", "opencode")
  const files: ReadonlyArray<{
    readonly args: ReadonlyArray<string>
    readonly cwd: string
  }> = [
    {
      cwd: opencodeRoot,
      args: [
        "--conditions=@ready-for-agent/source",
        "test",
        "test/v2-cli-contract.spec.ts",
        "--timeout",
        "60000",
      ],
    },
    {
      cwd: opencodeRoot,
      args: [
        "--conditions=@ready-for-agent/source",
        "test",
        "--cwd",
        "../../apps/ready-for-agent",
        "src/interactive-resume-v2-contract.test.ts",
        "--timeout",
        "60000",
      ],
    },
  ]

  let pass = 0
  let fail = 0
  let skip = 0
  const logs: string[] = []
  for (const file of files) {
    const result = await runBun(file.args, file.cwd, env)
    const output = redactContractText(result.output, secrets)
    logs.push(output)
    const counts = parseSuiteCounts(output)
    pass += counts.pass
    fail += counts.fail
    skip += counts.skip
    if (result.status !== 0) {
      const message = [
        log,
        `OpenCode CLI contract suite failed (exit ${String(result.status)}).`,
        gate.mode === "latest"
          ? `Upstream drift: latest stable V2 ${gate.version} broke the contracts. Baseline pin remains ${gate.baseline}.`
          : `Pinned baseline ${gate.baseline} failed the production command contracts.`,
        `Cases so far: ${String(pass)} pass, ${String(skip)} skip, ${String(fail)} fail. Expected ${String(EXPECTED_OPENCODE_CLI_CONTRACT_CASES)} passing cases.`,
      ].join("\n")
      writeFileSync(join(directory, "suite.log"), logs.join("\n"))
      writeFileSync(join(directory, "failure.txt"), `${message}\n`)
      console.error(message)
      return { status: result.status, message }
    }
  }

  writeFileSync(join(directory, "suite.log"), logs.join("\n"))
  const summary = `cases pass=${String(pass)} skip=${String(skip)} fail=${String(fail)} expected=${String(EXPECTED_OPENCODE_CLI_CONTRACT_CASES)}`
  record(directory, gate, summary)
  console.log(`[opencode-cli-contract] ${summary}`)
  writeSummary(`- cases: ${summary}\n`)

  if (
    pass !== EXPECTED_OPENCODE_CLI_CONTRACT_CASES ||
    skip !== 0 ||
    fail !== 0
  ) {
    const message = `OpenCode CLI contract finished with ${String(pass)} pass, ${String(skip)} skip, ${String(fail)} fail. Expected ${String(EXPECTED_OPENCODE_CLI_CONTRACT_CASES)} passing cases and zero skips. An empty or skipped suite is not a pass.`
    writeFileSync(join(directory, "failure.txt"), `${message}\n`)
    console.error(message)
    return { status: 1, message }
  }

  return { status: 0, message: log }
}

if (import.meta.main) {
  const result = await runOpenCodeCliContract()
  process.exit(result.status)
}
