/**
 * Opt-in Usage completions: generate from `ready-for-agent --usage`,
 * process-level `usage complete-word` candidates, standalone Effect
 * `--completions`, and on-demand (not packaged) artifacts.
 */

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  USAGE_COMPLETION_SHELLS,
  generateUsageCompletion,
} from "../scripts/generate-usage-completions.ts"
import { describe, expect, test } from "bun:test"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")
const pinnedUsage = join(workspaceRoot, "scripts", "run-pinned-usage.sh")
const mainPath = join(appRoot, "src/main.ts")
const publicReadmePath = join(workspaceRoot, "README.md")
const contributingPath = join(workspaceRoot, "CONTRIBUTING.md")

const PUBLIC_COMMANDS = [
  "start",
  "add",
  "candidates",
  "intake",
  "retry",
  "status",
  "jump",
] as const

const EFFECT_GLOBAL_FLAGS = [
  "--help",
  "--version",
  "--completions",
  "--log-level",
] as const

const INTERNAL_TOKENS = [
  "--usage",
  "--no-no-open",
  "--ready-for-agent-internal-github-helper",
  "--ready-for-agent-internal-gitlab-helper",
  "--ready-for-agent-internal-azure-devops-helper",
  "--ready-for-agent-internal-keymaxxer-sidecar",
] as const

const PLATFORM_PACKAGES = [
  "ready-for-agent-linux-x64",
  "ready-for-agent-linux-arm64",
  "ready-for-agent-darwin-x64",
  "ready-for-agent-darwin-arm64",
  "ready-for-agent-win32-x64",
  "ready-for-agent-win32-arm64",
] as const

const EFFECT_COMPLETION_SHELLS = ["bash", "zsh", "fish", "sh"] as const

type ProcessResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const runSourceCli = (
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly env?: NodeJS.ProcessEnv
    readonly path?: string
  } = {},
): ProcessResult => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...options.env,
  }
  if (options.path !== undefined) {
    env.PATH = options.path
  }
  const result = spawnSync(
    "bun",
    ["--conditions", "@ready-for-agent/source", mainPath, ...args],
    {
      cwd: options.cwd ?? appRoot,
      encoding: "utf8",
      env,
    },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

const runPinnedUsage = (
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly input?: string
  } = {},
): ProcessResult => {
  const result = spawnSync("bash", [pinnedUsage, ...args], {
    cwd: options.cwd ?? appRoot,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

const usageSpecFromReadyForAgent = (): string => {
  const emitted = runSourceCli(["--usage"])
  expect(emitted.status, emitted.stderr).toBe(0)
  expect(emitted.stderr).toBe("")
  expect(emitted.stdout).toContain('min_usage_version "5.1.0"')
  return emitted.stdout
}

const completeWordFromUsage = (
  words: readonly string[],
  cwd: string = appRoot,
): string[] => {
  const completed = runPinnedUsage(
    ["complete-word", "-f", "-", "--", ...words],
    { cwd, input: usageSpecFromReadyForAgent() },
  )
  expect(completed.status, completed.stderr).toBe(0)
  return completed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const assertNoForbiddenTokens = (text: string): void => {
  for (const token of INTERNAL_TOKENS) {
    expect(text).not.toContain(token)
  }
}

describe("Usage-generated operator CLI completions", () => {
  test("pinned Usage 5.1.0 is available for completion generation", () => {
    const version = runPinnedUsage(["--version"])
    expect(version.status, version.stderr).toBe(0)
    expect(version.stdout).toContain("5.1.0")
  })

  test("complete-word via ready-for-agent --usage offers every public subcommand", () => {
    const words = completeWordFromUsage(["ready-for-agent", ""])
    expect(words.sort()).toEqual([...PUBLIC_COMMANDS].sort())
    assertNoForbiddenTokens(words.join("\n"))
  })

  test("complete-word via --usage offers Effect global flags and root start flags", () => {
    const words = completeWordFromUsage(["ready-for-agent", "--"])
    for (const flag of EFFECT_GLOBAL_FLAGS) {
      expect(words).toContain(flag)
    }
    expect(words).toContain("--no-open")
    expect(words).toContain("--host")
    assertNoForbiddenTokens(words.join("\n"))
  })

  test("complete-word via --usage offers command-local flags", () => {
    const start = completeWordFromUsage(["ready-for-agent", "start", "--"])
    expect(start).toContain("--no-open")
    expect(start).toContain("--host")
    for (const flag of EFFECT_GLOBAL_FLAGS) {
      expect(start).toContain(flag)
    }
    assertNoForbiddenTokens(start.join("\n"))

    const add = completeWordFromUsage(["ready-for-agent", "add", "--"])
    expect(add).toContain("--forge-host")
    expect(add).toContain("--project-path")
    for (const flag of EFFECT_GLOBAL_FLAGS) {
      expect(add).toContain(flag)
    }
    assertNoForbiddenTokens(add.join("\n"))

    const retry = completeWordFromUsage(["ready-for-agent", "retry", "--"])
    expect(retry).toContain("--issue")
    expect(retry).toContain("--work-item")
    expect(retry).toContain("--all-retryable")
    expect(retry).toContain("--max-autonomous-retries")
    for (const flag of EFFECT_GLOBAL_FLAGS) {
      expect(retry).toContain(flag)
    }
    assertNoForbiddenTokens(retry.join("\n"))
  })

  test("complete-word via --usage offers --log-level and --completions choices", () => {
    const levels = completeWordFromUsage(["ready-for-agent", "--log-level", ""])
    expect(levels).toEqual([
      "all",
      "trace",
      "debug",
      "info",
      "warn",
      "warning",
      "error",
      "fatal",
      "none",
    ])

    const shells = completeWordFromUsage([
      "ready-for-agent",
      "--completions",
      "",
    ])
    expect(shells).toEqual(["bash", "zsh", "fish", "sh"])
  })

  test("add path completion via --usage offers local directories only", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-usage-comp-"))
    try {
      writeFileSync(join(tempRoot, "notes.txt"), "file\n")
      mkdirSync(join(tempRoot, "repo-dir"))
      const words = completeWordFromUsage(
        ["ready-for-agent", "add", ""],
        tempRoot,
      )
      expect(words.some((word) => word.replace(/\/$/, "") === "repo-dir")).toBe(
        true,
      )
      expect(
        words.some((word) => word.replace(/\/$/, "") === "notes.txt"),
      ).toBe(false)
      assertNoForbiddenTokens(words.join("\n"))
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("complete-word via --usage does not contact GraphQL", async () => {
    const { createServer } = await import("node:http")
    let graphqlHits = 0
    const server = createServer((_req, res) => {
      graphqlHits += 1
      res.writeHead(500)
      res.end("unexpected")
    })
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve())
      server.on("error", reject)
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      server.close()
      throw new Error("expected TCP address")
    }

    try {
      const emitted = runSourceCli(["--usage"], {
        env: {
          READY_FOR_AGENT_GRAPHQL_URL: `http://127.0.0.1:${address.port}/graphql`,
        },
      })
      expect(emitted.status).toBe(0)
      const completed = runPinnedUsage(
        ["complete-word", "-f", "-", "--", "ready-for-agent", ""],
        { input: emitted.stdout },
      )
      expect(completed.status, completed.stderr).toBe(0)
      expect(completed.stdout).toContain("start")
      expect(graphqlHits).toBe(0)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  })

  test("generation uses ready-for-agent --usage for every Usage shell", () => {
    expect([...USAGE_COMPLETION_SHELLS]).toEqual([
      "bash",
      "zsh",
      "fish",
      "nu",
      "powershell",
    ])

    for (const shell of USAGE_COMPLETION_SHELLS) {
      const script = generateUsageCompletion({ shell })
      expect(script.length, shell).toBeGreaterThan(0)
      expect(script, shell).toContain("ready-for-agent --usage")
      expect(script, shell).toContain("usage")
      expect(script, shell).not.toContain("ready-for-agent.usage.kdl")
      expect(script, shell).not.toMatch(/complete\s+run=/)
      expect(script, shell).not.toMatch(/mount\s+run=/)
      expect(script, shell).not.toContain("--no-no-open")
      expect(script, shell).not.toContain(
        "--ready-for-agent-internal-github-helper",
      )
      expect(script, shell).not.toContain(
        "--ready-for-agent-internal-gitlab-helper",
      )
      expect(script, shell).not.toContain(
        "--ready-for-agent-internal-azure-devops-helper",
      )
      expect(script, shell).not.toContain(
        "--ready-for-agent-internal-keymaxxer-sidecar",
      )
    }
  })

  test("unknown shells are rejected without writing a script", () => {
    expect(() => generateUsageCompletion({ shell: "csh" })).toThrow(
      /bash.*zsh.*fish.*nu.*powershell/i,
    )
  })

  test("Nx generate-usage-completions target accepts each Usage shell", async () => {
    const project = JSON.parse(
      await readFileSync(join(appRoot, "project.json"), "utf8"),
    ) as {
      targets: Record<
        string,
        {
          command?: string
          options?: { command?: string; args?: string }
          cache?: boolean
          outputs?: unknown[]
        }
      >
    }

    const target = project.targets["generate-usage-completions"]
    const command = target?.options?.command ?? target?.command ?? ""
    expect(command).toContain("scripts/generate-usage-completions.ts")
    expect(command).toContain("{args.shell}")
    expect(command).not.toContain("ready-for-agent.usage.kdl")
    expect(command).not.toContain(" -f ")
    expect(target?.options?.args).toBe("--shell=bash")
    expect(target?.outputs ?? []).toEqual([])
    expect(target?.cache).toBe(false)
  })

  test("generated completion scripts are not checked in or shipped", () => {
    const launcher = JSON.parse(
      readFileSync(join(appRoot, "package.json"), "utf8"),
    ) as { files?: string[]; dependencies?: Record<string, string> }
    expect(launcher.files).toEqual([
      "bin/ready-for-agent.js",
      "bin/select-platform.js",
      "README.md",
    ])
    expect(launcher.dependencies ?? {}).not.toHaveProperty("usage")

    for (const name of PLATFORM_PACKAGES) {
      const pkg = JSON.parse(
        readFileSync(
          join(workspaceRoot, "packages", name, "package.json"),
          "utf8",
        ),
      ) as { files?: string[] }
      expect(pkg.files, name).toHaveLength(2)
      expect(pkg.files?.[1], name).toBe("README.md")
      expect(pkg.files?.[0], name).toMatch(/^bin\/ready-for-agent(\.exe)?$/)
    }

    const completionArtifacts = [
      "ready-for-agent.bash",
      "ready-for-agent.zsh",
      "_ready-for-agent",
      "ready-for-agent.fish",
      "ready-for-agent.nu",
      "ready-for-agent.ps1",
    ]
    const trackedRoots = [appRoot, join(workspaceRoot, "packages")]
    for (const root of trackedRoots) {
      const listing = readdirSync(root, { recursive: true, encoding: "utf8" })
      for (const entry of listing) {
        if (entry.split("/").includes("node_modules")) {
          continue
        }
        const base = entry.split("/").at(-1) ?? entry
        expect(completionArtifacts, `${root}/${entry}`).not.toContain(base)
      }
    }
  })

  test("standalone --completions still works for bash, zsh, fish, and sh without Usage", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-no-usage-"))
    const markerPath = join(fixtureRoot, "usage-was-invoked")
    const stubUsage = join(fixtureRoot, "usage")
    writeFileSync(
      stubUsage,
      `#!/bin/sh\nprintf '%s\\n' invoked > "${markerPath}"\nexit 127\n`,
    )
    chmodSync(stubUsage, 0o755)

    try {
      const pathWithStubFirst = `${fixtureRoot}:${process.env.PATH ?? ""}`
      for (const shell of EFFECT_COMPLETION_SHELLS) {
        if (existsSync(markerPath)) {
          rmSync(markerPath)
        }
        const result = runSourceCli(["--completions", shell], {
          path: pathWithStubFirst,
        })
        expect(result.status, `${shell}\n${result.stderr}`).toBe(0)
        expect(result.stdout.length, shell).toBeGreaterThan(0)
        expect(result.stdout, shell).not.toContain("usage CLI not found")
        expect(result.stdout, shell).not.toContain("ready-for-agent --usage")
        expect(existsSync(markerPath), `${shell} invoked Usage`).toBe(false)
        expect(result.stdout, shell).not.toContain("--usage")
        expect(result.stdout, shell).not.toContain(
          "--ready-for-agent-internal-github-helper",
        )
        expect(result.stdout, shell).not.toContain(
          "--ready-for-agent-internal-gitlab-helper",
        )
        expect(result.stdout, shell).not.toContain(
          "--ready-for-agent-internal-azure-devops-helper",
        )
        expect(result.stdout, shell).not.toContain(
          "--ready-for-agent-internal-keymaxxer-sidecar",
        )
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test("user documentation covers every Usage shell and the Usage 5.1.0 runtime dependency", () => {
    const readme = readFileSync(publicReadmePath, "utf8")
    const managedStart = readme.indexOf("<!-- usage:start -->")
    const managedEnd = readme.indexOf("<!-- usage:end -->")
    expect(managedStart).toBeGreaterThanOrEqual(0)
    expect(managedEnd).toBeGreaterThan(managedStart)
    const outsideManaged = `${readme.slice(0, managedStart)}${readme.slice(managedEnd)}`

    expect(outsideManaged).toMatch(/shell completions/i)
    expect(outsideManaged).toContain("ready-for-agent --completions")
    expect(outsideManaged).toContain("Usage v5.1.0")
    expect(outsideManaged).toMatch(/runtime dependency/i)
    expect(outsideManaged).toContain("--usage-cmd")
    expect(outsideManaged).toContain("ready-for-agent --usage")
    expect(outsideManaged).toContain("bash")
    expect(outsideManaged).toContain("zsh")
    expect(outsideManaged).toContain("fish")
    expect(outsideManaged).toMatch(/nushell|\bnu\b/i)
    expect(outsideManaged).toMatch(/powershell/i)
    expect(outsideManaged).toContain("ready-for-agent --completions bash")
    expect(outsideManaged).toContain("ready-for-agent --completions zsh")
    expect(outsideManaged).toContain("ready-for-agent --completions fish")
    expect(outsideManaged).toContain("ready-for-agent --completions sh")
  })

  test("contributor documentation shows how to generate each Usage completion flavor", () => {
    const contributing = readFileSync(contributingPath, "utf8")
    expect(contributing).toContain(
      "bunx nx run ready-for-agent:generate-usage-completions",
    )
    expect(contributing).toContain("--shell=bash")
    expect(contributing).toContain("--shell=zsh")
    expect(contributing).toContain("--shell=fish")
    expect(contributing).toContain("--shell=nu")
    expect(contributing).toContain("--shell=powershell")
    expect(contributing).toContain("ready-for-agent --usage")
    expect(contributing).toContain("Usage v5.1.0")
  })
})
