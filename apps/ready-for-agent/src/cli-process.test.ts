/**
 * Exact operator-binary process contract for finite commands.
 *
 * Mock GraphQL servers run in this process, so child CLI processes must be
 * spawned asynchronously — `spawnSync` blocks the event loop and the mock
 * never answers the request (deadlock).
 */

import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { type Server, createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLI_SCHEMA_VERSION, buildAddSuccessDocument } from "./cli-json.ts"
import {
  HARNESS_START_HINT,
  HARNESS_UNREACHABLE_CODE,
  harnessNotRunningMessage,
} from "./graphql-error.ts"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

const initFixtureRepo = (repoDir: string): void => {
  mkdirSync(repoDir)
  writeFileSync(join(repoDir, "README.md"), "fixture\n")
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: repoDir, encoding: "utf8" })
  expect(git(["init"]).status).toBe(0)
  expect(
    git(["remote", "add", "origin", "git@github.com:owner/repo.git"]).status,
  ).toBe(0)
}

/**
 * Finite commands must emit exactly one compact JSON document on the
 * relevant stream — no banners, stacks, or progress lines mixed in.
 */
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

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("expected TCP address"))
        return
      }
      resolve(address.port)
    })
    server.on("error", reject)
  })

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
  })

type ProcessResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const runAdd = (repoDir: string, graphqlUrl: string): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        "--conditions",
        "@ready-for-agent/source",
        "src/main.ts",
        "add",
        repoDir,
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          READY_FOR_AGENT_GRAPHQL_URL: graphqlUrl,
          // Keep CLI error JSON free of ANSI so process contracts stay exact.
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`add timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 20_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })

describe("operator binary finite-command process contract", () => {
  let tempRoot = ""

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-cli-process-"))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test("add against unreachable GraphQL emits JSON error on stderr only", async () => {
    const repoDir = join(tempRoot, "repo")
    initFixtureRepo(repoDir)

    const result = await runAdd(repoDir, "http://127.0.0.1:1/graphql")

    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe("")
    const errorDoc = parseExactlyOneJsonDocument(result.stderr)
    expect(errorDoc).toEqual({
      schemaVersion: CLI_SCHEMA_VERSION,
      command: "add",
      error: {
        code: HARNESS_UNREACHABLE_CODE,
        message: harnessNotRunningMessage("http://127.0.0.1:1"),
      },
    })
    // Message value may embed the start hint (escaped in the JSON line).
    expect(result.stderr).toContain(HARNESS_START_HINT)
    expect(result.stderr.split(HARNESS_START_HINT).length - 1).toBe(1)
    expect(result.stderr).not.toContain("Unable to connect")
    expect(result.stderr).not.toContain("access the url")
    expect(result.stderr).not.toMatch(/\s+at\s+\S+\s+\(/)
    expect(result.stderr).not.toContain("FiniteCommandFailed:")
    expect(result.stderr).not.toContain("GraphqlRequestFailed:")
    expect(result.stderr.toLowerCase()).not.toContain("starting harness")
    expect(result.stdout.toLowerCase()).not.toContain("starting harness")
  })

  test("add success emits one JSON document on stdout and exits 0", async () => {
    const repoDir = join(tempRoot, "repo-success")
    initFixtureRepo(repoDir)

    const seenBodies: string[] = []
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405)
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      req.on("end", () => {
        seenBodies.push(Buffer.concat(chunks).toString("utf8"))
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            data: {
              addRepository: {
                id: "repo-process-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "owner/repo",
                localPath: repoDir,
                isBare: false,
              },
            },
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runAdd(repoDir, `http://127.0.0.1:${port}/graphql`)

      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe("")
      expect(seenBodies.some((body) => body.includes("addRepository"))).toBe(
        true,
      )
      const successDoc = parseExactlyOneJsonDocument(result.stdout)
      expect(successDoc).toEqual(
        buildAddSuccessDocument({
          id: "repo-process-1",
          forge: "github",
          forgeHost: "github.com",
          projectPath: "owner/repo",
          localPath: repoDir,
          isBare: false,
        }),
      )
      expect(result.stdout).not.toContain("Added repository")
    } finally {
      await closeServer(server)
    }
  })

  test("add GraphQL domain failure preserves extensions.code on stderr", async () => {
    const repoDir = join(tempRoot, "repo-domain-fail")
    initFixtureRepo(repoDir)

    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405)
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            data: null,
            errors: [
              {
                message: "Repository owner/repo already exists on github.com",
                extensions: { code: "REPOSITORY_ALREADY_EXISTS" },
              },
            ],
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runAdd(repoDir, `http://127.0.0.1:${port}/graphql`)

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      const errorDoc = parseExactlyOneJsonDocument(result.stderr)
      expect(errorDoc).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "add",
        error: {
          code: "REPOSITORY_ALREADY_EXISTS",
          message: "Repository owner/repo already exists on github.com",
        },
      })
      expect(result.stderr).not.toMatch(/\s+at\s+\S+\s+\(/)
      expect(result.stderr).not.toContain("FiniteCommandFailed:")
    } finally {
      await closeServer(server)
    }
  })
})
