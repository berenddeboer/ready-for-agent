/**
 * Process-level `ready-for-agent --usage` contract: exact stdout, empty
 * stderr, exit 0, and no Harness / GraphQL / Effect CLI startup.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const mainPath = join(packageRoot, "src/main.ts")
const usageSpecPath = join(packageRoot, "ready-for-agent.usage.kdl")

const checkedInUsageContract = readFileSync(usageSpecPath, "utf8")

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
  } = {},
): ProcessResult => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...options.env,
  }
  const result = spawnSync(
    "bun",
    ["--conditions", "@ready-for-agent/source", mainPath, ...args],
    {
      cwd: options.cwd ?? packageRoot,
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

describe("source process Usage metadata emission", () => {
  test("exact root --usage writes the checked-in contract and exits 0", () => {
    const result = runSourceCli(["--usage"])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe(checkedInUsageContract)
    expect(result.stdout.endsWith("\n")).toBe(true)
    expect(result.stdout.endsWith("\n\n")).toBe(false)
    expect(result.stdout).toContain('min_usage_version "5.1.0"')
  })

  test("successful emission does not start the Harness or contact GraphQL", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-usage-"))
    const databasePath = join(fixtureRoot, "ready-for-agent.db")
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
    const graphqlUrl = `http://127.0.0.1:${address.port}/graphql`

    try {
      const result = runSourceCli(["--usage"], {
        cwd: fixtureRoot,
        env: {
          READY_FOR_AGENT_GRAPHQL_URL: graphqlUrl,
          SQLITE_DATABASE_PATH: databasePath,
          PORT: String(18_900 + Math.floor(Math.random() * 80)),
          NO_BROWSER: "1",
        },
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe(checkedInUsageContract)
      expect(result.stdout.toLowerCase()).not.toContain("starting harness")
      expect(result.stdout.toLowerCase()).not.toContain("listening on")
      expect(result.stderr.toLowerCase()).not.toContain("starting harness")
      expect(graphqlHits).toBe(0)
      expect(existsSync(databasePath)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test("other --usage placements are not the metadata invocation", () => {
    const placements = [
      ["--usage", "extra"],
      ["start", "--usage"],
      ["--help", "--usage"],
      ["--USAGE"],
      ["--usage=1"],
    ] as const

    for (const args of placements) {
      const result = runSourceCli(args)
      expect(result.stdout, args.join(" ")).not.toBe(checkedInUsageContract)
      expect(result.stdout, args.join(" ")).not.toContain(
        'min_usage_version "5.1.0"',
      )
    }
  })

  test("Effect help, version, and completions stay public and hide --usage", () => {
    const help = runSourceCli(["--help"])
    expect(help.status).toBe(0)
    expect(`${help.stdout}\n${help.stderr}`).toContain("start")
    expect(`${help.stdout}\n${help.stderr}`).not.toContain("--usage")

    const version = runSourceCli(["--version"])
    expect(version.status).toBe(0)
    expect(version.stdout.trim().length).toBeGreaterThan(0)
    expect(version.stdout).not.toBe(checkedInUsageContract)
    expect(version.stdout).not.toContain("--usage")

    const completions = runSourceCli(["--completions", "bash"])
    expect(completions.status).toBe(0)
    expect(completions.stdout.length).toBeGreaterThan(0)
    expect(completions.stdout).not.toContain("--usage")
  })

  test("internal helper dispatch is unchanged and does not emit the contract", () => {
    const helper = runSourceCli(["--ready-for-agent-internal-github-helper"])
    expect(helper.stdout).not.toBe(checkedInUsageContract)
    expect(helper.stdout).not.toContain('min_usage_version "5.1.0"')
    expect(helper.stderr).toContain("Unknown GitHub helper operation")
    expect(helper.status).not.toBe(0)

    const helperWithUsage = runSourceCli([
      "--ready-for-agent-internal-github-helper",
      "--usage",
    ])
    expect(helperWithUsage.stdout).not.toBe(checkedInUsageContract)
    expect(helperWithUsage.stderr).toContain("Unknown GitHub helper operation")
    expect(helperWithUsage.status).not.toBe(0)
  })
})
