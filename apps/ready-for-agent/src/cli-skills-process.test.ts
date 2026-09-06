/**
 * Process-level skill discovery contract: offline list/get, one document on
 * stdout, JSON errors on stderr, and no Harness / GraphQL / product data.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  LIFECYCLE_STEP_AGENT_FREE,
  STEP_RUN_REASONS,
  WORK_ITEM_STATES,
} from "@ready-for-agent/lifecycle-model"
import { CLI_SCHEMA_VERSION } from "./cli-json.ts"
import { READY_FOR_AGENT_VERSION } from "./generated/version.ts"
import { describe, expect, test } from "bun:test"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const mainPath = join(packageRoot, "src/main.ts")

const PUBLIC_SKILL_IDS = [
  "core",
  "reporting",
  "operating",
  "recovery",
  "lifecycle",
] as const

const CHECKOUT_LOCAL_PATH_MARKERS = [
  "scripts/",
  "references/",
  ".agents/",
  "packages/",
  "apps/",
] as const

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

const parseExactlyOneJsonDocument = (text: string): unknown => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  expect(lines).toHaveLength(1)
  const line = lines[0]
  expect(line).toBeDefined()
  if (line === undefined) {
    throw new Error(`expected one JSON document, got:\n${text}`)
  }
  return JSON.parse(line)
}

type SkillSafety = {
  readonly read: boolean
  readonly write: boolean
  readonly destructive: boolean
  readonly tokenSpending: boolean
  readonly fanOut: boolean
}

type SkillListEntry = {
  readonly id: string
  readonly summary: string
  readonly mediaType: string
  readonly effect: string
  readonly safety: SkillSafety
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseSkillSafety = (value: unknown): SkillSafety => {
  expect(isRecord(value)).toBe(true)
  if (!isRecord(value)) {
    throw new Error("expected skill safety object")
  }
  expect(typeof value.read).toBe("boolean")
  expect(typeof value.write).toBe("boolean")
  expect(typeof value.destructive).toBe("boolean")
  expect(typeof value.tokenSpending).toBe("boolean")
  expect(typeof value.fanOut).toBe("boolean")
  return {
    read: value.read as boolean,
    write: value.write as boolean,
    destructive: value.destructive as boolean,
    tokenSpending: value.tokenSpending as boolean,
    fanOut: value.fanOut as boolean,
  }
}

const parseSkillListEntry = (value: unknown): SkillListEntry => {
  expect(isRecord(value)).toBe(true)
  if (!isRecord(value)) {
    throw new Error("expected skill list entry")
  }
  expect(typeof value.id).toBe("string")
  expect(typeof value.summary).toBe("string")
  expect(value.mediaType).toBe("text/markdown")
  expect(typeof value.effect).toBe("string")
  expect(value).not.toHaveProperty("content")
  return {
    id: value.id as string,
    summary: value.summary as string,
    mediaType: value.mediaType as string,
    effect: value.effect as string,
    safety: parseSkillSafety(value.safety),
  }
}

describe("source process skill discovery", () => {
  test("skills list --json is versioned, compact, and lists operational IDs", () => {
    const result = runSourceCli(["skills", "list", "--json"])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    const document = parseExactlyOneJsonDocument(result.stdout)
    expect(isRecord(document)).toBe(true)
    if (!isRecord(document)) {
      throw new Error("expected skills list JSON object")
    }
    expect(document.schemaVersion).toBe(CLI_SCHEMA_VERSION)
    expect(document.command).toBe("skills")
    expect(document.version).toBe(READY_FOR_AGENT_VERSION)
    expect(Array.isArray(document.skills)).toBe(true)
    const skills = (document.skills as unknown[]).map(parseSkillListEntry)
    expect(skills.map((skill) => skill.id)).toEqual([...PUBLIC_SKILL_IDS])
    expect(skills.every((skill) => skill.summary.length > 0)).toBe(true)
    expect(skills.find((skill) => skill.id === "core")?.effect).toBe("read")
    expect(
      skills.find((skill) => skill.id === "operating")?.safety.fanOut,
    ).toBe(true)
    expect(
      skills.find((skill) => skill.id === "operating")?.safety.tokenSpending,
    ).toBe(true)
    expect(
      skills.find((skill) => skill.id === "recovery")?.safety.destructive,
    ).toBe(true)
  })

  test("skills with no child command aliases skills list", () => {
    const aliased = runSourceCli(["skills", "--json"])
    const listed = runSourceCli(["skills", "list", "--json"])
    expect(aliased.status).toBe(0)
    expect(aliased.stderr).toBe("")
    expect(aliased.stdout).toBe(listed.stdout)
  })

  test("skills get writes deterministic Markdown and JSON wraps the same body", () => {
    const markdown = runSourceCli(["skills", "get", "core"])
    expect(markdown.status).toBe(0)
    expect(markdown.stderr).toBe("")
    expect(markdown.stdout.startsWith("#")).toBe(true)
    expect(markdown.stdout).toContain(READY_FOR_AGENT_VERSION)
    expect(markdown.stdout).toContain("ready-for-agent skills get reporting")
    expect(markdown.stdout).toContain("ready-for-agent skills get operating")
    expect(markdown.stdout).toContain("ready-for-agent skills get recovery")
    expect(markdown.stdout.endsWith("\n")).toBe(true)
    expect(markdown.stdout.endsWith("\n\n")).toBe(false)

    const json = runSourceCli(["skills", "get", "core", "--json"])
    expect(json.status).toBe(0)
    expect(json.stderr).toBe("")
    const document = parseExactlyOneJsonDocument(json.stdout)
    expect(isRecord(document)).toBe(true)
    if (!isRecord(document)) {
      throw new Error("expected skills get JSON object")
    }
    expect(document.schemaVersion).toBe(CLI_SCHEMA_VERSION)
    expect(document.command).toBe("skills")
    expect(document.version).toBe(READY_FOR_AGENT_VERSION)
    expect(isRecord(document.skill)).toBe(true)
    if (!isRecord(document.skill)) {
      throw new Error("expected skill object")
    }
    const { content, ...skillWithoutContent } = document.skill
    const entry = parseSkillListEntry(skillWithoutContent)
    expect(entry.id).toBe("core")
    expect(content).toBe(markdown.stdout)
  })

  test("every listed ID resolves and unknown IDs fail with a JSON error", () => {
    const listed = runSourceCli(["skills", "list", "--json"])
    const document = parseExactlyOneJsonDocument(listed.stdout)
    expect(isRecord(document)).toBe(true)
    if (!isRecord(document) || !Array.isArray(document.skills)) {
      throw new Error("expected skills array")
    }
    const ids = document.skills.map((skill) => parseSkillListEntry(skill).id)
    for (const id of ids) {
      const got = runSourceCli(["skills", "get", id])
      expect(got.status, id).toBe(0)
      expect(got.stderr, id).toBe("")
      expect(got.stdout.length, id).toBeGreaterThan(0)
    }

    const unknown = runSourceCli(["skills", "get", "bootstrap"])
    expect(unknown.status).not.toBe(0)
    expect(unknown.stdout).toBe("")
    const errorDoc = parseExactlyOneJsonDocument(unknown.stderr)
    expect(isRecord(errorDoc)).toBe(true)
    if (!isRecord(errorDoc) || !isRecord(errorDoc.error)) {
      throw new Error("expected skills error document")
    }
    expect(errorDoc.schemaVersion).toBe(CLI_SCHEMA_VERSION)
    expect(errorDoc.command).toBe("skills")
    expect(errorDoc.error.code).toBe("SKILL_NOT_FOUND")
    expect(String(errorDoc.error.message)).toContain("bootstrap")
    expect(unknown.stderr).toContain("ready-for-agent skills list")
    for (const id of PUBLIC_SKILL_IDS) {
      expect(unknown.stderr).toContain(id)
    }
  })

  test("discovery is offline from an unrelated cwd and creates no product data", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-skills-"))
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
      for (const args of [
        ["skills", "list", "--json"],
        ["skills", "get", "core"],
        ["skills", "get", "not-a-skill"],
      ] as const) {
        const result = runSourceCli(args, {
          cwd: fixtureRoot,
          env: {
            READY_FOR_AGENT_GRAPHQL_URL: graphqlUrl,
            SQLITE_DATABASE_PATH: databasePath,
            PORT: String(18_900 + Math.floor(Math.random() * 80)),
            NO_BROWSER: "1",
          },
        })
        expect(result.stdout.toLowerCase()).not.toContain("starting harness")
        expect(result.stderr.toLowerCase()).not.toContain("starting harness")
      }
      expect(graphqlHits).toBe(0)
      expect(existsSync(databasePath)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test("served guidance covers reporting, intake, retry, recovery, JSON, and GraphQL", () => {
    const bodies = Object.fromEntries(
      PUBLIC_SKILL_IDS.map((id) => {
        const result = runSourceCli(["skills", "get", id])
        expect(result.status, id).toBe(0)
        return [id, result.stdout]
      }),
    ) as Record<(typeof PUBLIC_SKILL_IDS)[number], string>
    const all = Object.values(bodies).join("\n")

    expect(bodies.reporting).toContain("window")
    expect(bodies.reporting).toContain("lifecycleLabels")
    expect(bodies.reporting).toContain("committedPullRequestsCount")
    expect(bodies.reporting).toContain("workItems(")
    expect(bodies.reporting).toContain("SQLITE_DATABASE_PATH")
    expect(bodies.reporting).toContain("Application Support")
    expect(bodies.reporting).toContain("LOCALAPPDATA")

    expect(bodies.operating).toContain("ready-for-agent candidates")
    expect(bodies.operating).toContain("ready-for-agent intake")
    expect(bodies.operating).toContain("ready-for-agent retry")
    expect(bodies.operating).toContain("--all-retryable")
    expect(bodies.operating).toContain("implementNow")
    expect(bodies.operating).toContain("Waiting for blockers")
    expect(bodies.operating).toContain("listed blockers")
    expect(bodies.operating).toContain("ready-for-agent jump")

    expect(bodies.recovery).toContain("issue_closing_pull_request_unowned")
    expect(bodies.recovery).toContain("resetWorkItem")
    expect(bodies.recovery).toContain("canRetry")
    expect(bodies.recovery).toContain("failureCode")
    expect(bodies.recovery).toContain("latestStepRunReason")

    expect(bodies.core).toContain("schemaVersion")
    expect(bodies.core).toContain("__type")
    expect(bodies.core).toContain("READY_FOR_AGENT_GRAPHQL_URL")

    for (const marker of CHECKOUT_LOCAL_PATH_MARKERS) {
      expect(all).not.toContain(marker)
    }
  })

  test("Usage contract names every served skill ID", () => {
    const usage = readFileSync(
      join(packageRoot, "ready-for-agent.usage.kdl"),
      "utf8",
    )
    expect(usage).toContain('cmd "skills"')
    expect(usage).toContain('cmd "list"')
    expect(usage).toContain('cmd "get"')
    for (const id of PUBLIC_SKILL_IDS) {
      expect(usage).toContain(id)
    }

    const topLevelCommands = [
      ...usage.matchAll(/^cmd "([a-z][a-z0-9-]*)"/gm),
    ].map((match) => match[1])
    expect(topLevelCommands.length).toBeGreaterThan(0)
    const bodies = PUBLIC_SKILL_IDS.map((id) => {
      const result = runSourceCli(["skills", "get", id])
      expect(result.status, id).toBe(0)
      return result.stdout
    }).join("\n")
    for (const name of topLevelCommands) {
      if (name === "skills") {
        continue
      }
      expect(bodies).toContain(`ready-for-agent ${name}`)
    }
  })

  test("skills help lists list and get without starting the Harness", () => {
    const help = runSourceCli(["skills", "--help"])
    expect(help.status).toBe(0)
    const output = `${help.stdout}\n${help.stderr}`
    expect(output).toContain("list")
    expect(output).toContain("get")
    expect(output).toContain("--json")
  })

  test("installable skill is a discovery stub that routes to the CLI", () => {
    const stub = readFileSync(
      join(packageRoot, "../../.agents/skills/ready-for-agent/SKILL.md"),
      "utf8",
    )
    expect(stub).toContain("ready-for-agent skills list")
    expect(stub).toContain("ready-for-agent skills get core")
    expect(stub).toContain("ready-for-agent skills get operating")
    expect(stub).toContain("ready-for-agent skills get recovery")
    expect(stub).not.toContain("scripts/rfa_report.py")
    expect(stub).not.toContain("references/lifecycle.md")
    expect(stub.length).toBeLessThan(4000)
  })

  test("lifecycle skill enumerates ontology states and Step Run reasons", () => {
    const result = runSourceCli(["skills", "get", "lifecycle"])
    expect(result.status).toBe(0)
    for (const state of WORK_ITEM_STATES) {
      expect(result.stdout).toContain(state.toUpperCase())
    }
    for (const reason of STEP_RUN_REASONS) {
      expect(result.stdout).toContain(reason)
    }
    for (const [step, agentFree] of Object.entries(LIFECYCLE_STEP_AGENT_FREE)) {
      expect(result.stdout).toContain(
        `| \`${step.toUpperCase()}\` | \`${step}\` | ${agentFree ? "no" : "yes"} |`,
      )
    }
  })
})
