/**
 * Exact operator-binary process contract for finite commands.
 *
 * Mock GraphQL servers run in this process, so child CLI processes must be
 * spawned asynchronously — `spawnSync` blocks the event loop and the mock
 * never answers the request (deadlock).
 */

import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { type Server, createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CLI_SCHEMA_VERSION,
  buildAddSuccessDocument,
  buildCandidatesSuccessDocument,
  buildIntakeSuccessDocument,
  buildRetrySuccessDocument,
  buildStatusSuccessDocument,
} from "./cli-json.ts"
import { READY_FOR_AGENT_VERSION } from "./generated/version.ts"
import {
  GRAPHQL_URL_NOT_ENDPOINT_CODE,
  HARNESS_START_HINT,
  HARNESS_UNREACHABLE_CODE,
  HARNESS_VERSION_MISMATCH_CODE,
  harnessNotRunningMessage,
  harnessVersionMismatchMessage,
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

const runCli = (
  args: readonly string[],
  graphqlUrl: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      READY_FOR_AGENT_GRAPHQL_URL: graphqlUrl,
      // Keep CLI error JSON free of ANSI so process contracts stay exact.
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...extraEnv,
    }
    if (!("TMUX" in extraEnv)) {
      delete env.TMUX
    }
    const child = spawn(
      "bun",
      ["--conditions", "@ready-for-agent/source", "src/main.ts", ...args],
      {
        cwd: packageRoot,
        env,
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
      reject(
        new Error(
          `${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
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

const runAdd = (repoDir: string, graphqlUrl: string): Promise<ProcessResult> =>
  runCli(["add", repoDir], graphqlUrl)

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

  test("candidates success emits one JSON document on stdout and exits 0", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        seenBodies.push(body)
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: {
              intakeCandidates: {
                repository: {
                  id: "repo-process-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "owner/repo",
                  issuesReconciledAt: "2026-08-12T10:00:00.000Z",
                },
                candidates: [
                  {
                    issueNumber: 7,
                    title: "Ready",
                    url: "https://github.com/owner/repo/issues/7",
                    action: "IMPLEMENT_NOW",
                  },
                  {
                    issueNumber: 9,
                    title: "Blocked",
                    url: "https://github.com/owner/repo/issues/9",
                    action: "QUEUE",
                  },
                ],
              },
            },
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["candidates", "GitHub.com/Owner/Repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe("")
      expect(seenBodies.some((body) => body.includes("repositories"))).toBe(
        true,
      )
      expect(seenBodies.some((body) => body.includes("intakeCandidates"))).toBe(
        true,
      )
      const successDoc = parseExactlyOneJsonDocument(result.stdout)
      expect(successDoc).toEqual(
        buildCandidatesSuccessDocument({
          repository: {
            id: "repo-process-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          issuesReconciledAt: "2026-08-12T10:00:00.000Z",
          candidates: [
            {
              issueNumber: 7,
              title: "Ready",
              url: "https://github.com/owner/repo/issues/7",
              action: "IMPLEMENT_NOW",
            },
            {
              issueNumber: 9,
              title: "Blocked",
              url: "https://github.com/owner/repo/issues/9",
              action: "QUEUE",
            },
          ],
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  test("candidates GraphQL preflight failure preserves extensions.code on stderr", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: null,
            errors: [
              {
                message: "Agent Backend is unavailable",
                extensions: { code: "AGENT_BACKEND_UNAVAILABLE" },
              },
            ],
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["candidates", "github.com/owner/repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      const errorDoc = parseExactlyOneJsonDocument(result.stderr)
      expect(errorDoc).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "candidates",
        error: {
          code: "AGENT_BACKEND_UNAVAILABLE",
          message: "Agent Backend is unavailable",
        },
      })
      expect(result.stderr).not.toMatch(/\s+at\s+\S+\s+\(/)
      expect(result.stderr).not.toContain("FiniteCommandFailed:")
    } finally {
      await closeServer(server)
    }
  })

  test("candidates against an older Harness schema emits HARNESS_VERSION_MISMATCH", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        if (body.includes("intakeCandidates")) {
          res.end(
            JSON.stringify({
              data: null,
              errors: [
                {
                  message:
                    'Cannot query field "intakeCandidates" on type "Query".',
                  extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
                },
              ],
            }),
          )
          return
        }
        if (body.includes("version")) {
          res.end(
            JSON.stringify({
              data: null,
              errors: [
                {
                  message: 'Cannot query field "version" on type "Query".',
                  extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
                },
              ],
            }),
          )
          return
        }
        res.end(JSON.stringify({ data: null }))
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["candidates", "github.com/owner/repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stderr)).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "candidates",
        error: {
          code: HARNESS_VERSION_MISMATCH_CODE,
          message: harnessVersionMismatchMessage({
            cliVersion: READY_FOR_AGENT_VERSION,
            harnessBaseUrl: `http://127.0.0.1:${port}`,
            command: "candidates",
          }),
        },
      })
      expect(result.stderr).not.toContain("GRAPHQL_VALIDATION_FAILED")
      expect(result.stderr).not.toContain("intakeCandidates")
    } finally {
      await closeServer(server)
    }
  })

  test("candidates names the older Harness version when Query.version exists", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        if (body.includes("intakeCandidates")) {
          res.end(
            JSON.stringify({
              data: null,
              errors: [
                {
                  message:
                    'Cannot query field "intakeCandidates" on type "Query".',
                  extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
                },
              ],
            }),
          )
          return
        }
        if (body.includes("version")) {
          res.end(JSON.stringify({ data: { version: "0.18.0" } }))
          return
        }
        res.end(JSON.stringify({ data: null }))
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["candidates", "github.com/owner/repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stderr)).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "candidates",
        error: {
          code: HARNESS_VERSION_MISMATCH_CODE,
          message: harnessVersionMismatchMessage({
            cliVersion: READY_FOR_AGENT_VERSION,
            harnessVersion: "0.18.0",
            harnessBaseUrl: `http://127.0.0.1:${port}`,
            command: "candidates",
          }),
        },
      })
    } finally {
      await closeServer(server)
    }
  })

  test("status against an older Harness schema emits HARNESS_VERSION_MISMATCH", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("kanbanStatus")) {
          res.end(
            JSON.stringify({
              data: null,
              errors: [
                {
                  message: 'Cannot query field "kanbanStatus" on type "Query".',
                  extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
                },
              ],
            }),
          )
          return
        }
        if (body.includes("version")) {
          res.end(JSON.stringify({ data: { version: "0.18.0" } }))
          return
        }
        res.end(JSON.stringify({ data: null }))
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["status"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stderr)).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "status",
        error: {
          code: HARNESS_VERSION_MISMATCH_CODE,
          message: harnessVersionMismatchMessage({
            cliVersion: READY_FOR_AGENT_VERSION,
            harnessVersion: "0.18.0",
            harnessBaseUrl: `http://127.0.0.1:${port}`,
            command: "status",
          }),
        },
      })
      expect(result.stderr).not.toContain("GRAPHQL_VALIDATION_FAILED")
      expect(result.stderr).not.toContain("kanbanStatus")
    } finally {
      await closeServer(server)
    }
  })

  test("intake complete success emits JSON on stdout and exits 0", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        seenBodies.push(body)
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: {
              startRepositoryIntake: {
                repository: {
                  id: "repo-process-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "owner/repo",
                  issuesReconciledAt: "2026-08-12T10:00:00.000Z",
                },
                results: [
                  {
                    __typename: "RepositoryIntakeCreated",
                    issueNumber: 7,
                    title: "Ready",
                    url: "https://github.com/owner/repo/issues/7",
                    action: "IMPLEMENT_NOW",
                    workItem: {
                      id: "wi-7",
                      state: "CREATE_WORKTREE",
                      status: "QUEUED",
                    },
                  },
                ],
              },
            },
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["intake", "GitHub.com/Owner/Repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe("")
      expect(
        seenBodies.some((body) => body.includes("startRepositoryIntake")),
      ).toBe(true)
      expect(parseExactlyOneJsonDocument(result.stdout)).toEqual(
        buildIntakeSuccessDocument({
          repository: {
            id: "repo-process-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          issuesReconciledAt: "2026-08-12T10:00:00.000Z",
          results: [
            {
              issueNumber: 7,
              title: "Ready",
              url: "https://github.com/owner/repo/issues/7",
              action: "IMPLEMENT_NOW",
              outcome: "CREATED",
              workItem: {
                id: "wi-7",
                state: "CREATE_WORKTREE",
                status: "QUEUED",
              },
            },
          ],
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  test("intake partial failure emits result JSON on stdout and exits 1", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: {
              startRepositoryIntake: {
                repository: {
                  id: "repo-process-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "owner/repo",
                  issuesReconciledAt: null,
                },
                results: [
                  {
                    __typename: "RepositoryIntakeCreated",
                    issueNumber: 7,
                    title: "Ready",
                    url: "https://github.com/owner/repo/issues/7",
                    action: "IMPLEMENT_NOW",
                    workItem: {
                      id: "wi-7",
                      state: "CREATE_WORKTREE",
                      status: "QUEUED",
                    },
                  },
                  {
                    __typename: "RepositoryIntakeFailed",
                    issueNumber: 9,
                    title: "Race",
                    url: "https://github.com/owner/repo/issues/9",
                    action: "QUEUE",
                    error: {
                      code: "UNFINISHED_WORK_ITEM_EXISTS",
                      message: "Issue #9 already has an unfinished Work Item",
                    },
                  },
                ],
              },
            },
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["intake", "github.com/owner/repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stdout)).toEqual(
        buildIntakeSuccessDocument({
          repository: {
            id: "repo-process-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          issuesReconciledAt: null,
          results: [
            {
              issueNumber: 7,
              title: "Ready",
              url: "https://github.com/owner/repo/issues/7",
              action: "IMPLEMENT_NOW",
              outcome: "CREATED",
              workItem: {
                id: "wi-7",
                state: "CREATE_WORKTREE",
                status: "QUEUED",
              },
            },
            {
              issueNumber: 9,
              title: "Race",
              url: "https://github.com/owner/repo/issues/9",
              action: "QUEUE",
              outcome: "FAILED",
              error: {
                code: "UNFINISHED_WORK_ITEM_EXISTS",
                message: "Issue #9 already has an unfinished Work Item",
              },
            },
          ],
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  test("retry complete success emits JSON on stdout and exits 0", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        seenBodies.push(body)
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: {
              retryWorkItems: {
                repository: {
                  id: "repo-process-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "owner/repo",
                },
                results: [
                  {
                    __typename: "RetryWorkItemsRetried",
                    issueNumber: 7,
                    workItem: {
                      id: "wi-7",
                      state: "IMPLEMENT",
                      status: "QUEUED",
                    },
                  },
                ],
              },
            },
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["retry", "GitHub.com/Owner/Repo", "--all-retryable"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe("")
      expect(seenBodies.some((body) => body.includes("retryWorkItems"))).toBe(
        true,
      )
      expect(parseExactlyOneJsonDocument(result.stdout)).toEqual(
        buildRetrySuccessDocument({
          repository: {
            id: "repo-process-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          results: [
            {
              issueNumber: 7,
              outcome: "RETRIED",
              workItem: {
                id: "wi-7",
                state: "IMPLEMENT",
                status: "QUEUED",
              },
            },
          ],
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  test("retry partial failure emits result JSON on stdout and exits 1", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: {
              retryWorkItems: {
                repository: {
                  id: "repo-process-1",
                  forge: "github",
                  forgeHost: "github.com",
                  projectPath: "owner/repo",
                },
                results: [
                  {
                    __typename: "RetryWorkItemsRetried",
                    issueNumber: 7,
                    workItem: {
                      id: "wi-7",
                      state: "IMPLEMENT",
                      status: "QUEUED",
                    },
                  },
                  {
                    __typename: "RetryWorkItemsFailed",
                    issueNumber: 9,
                    workItem: {
                      id: "wi-9",
                      state: "IMPLEMENT",
                      status: "FAILED",
                    },
                    error: {
                      code: "ACTIVE_STEP_RUN_EXISTS",
                      message: "Work Item wi-9 already has an active Step Run",
                    },
                  },
                ],
              },
            },
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["retry", "github.com/owner/repo", "--work-item", "wi-9"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stdout)).toEqual(
        buildRetrySuccessDocument({
          repository: {
            id: "repo-process-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          results: [
            {
              issueNumber: 7,
              outcome: "RETRIED",
              workItem: {
                id: "wi-7",
                state: "IMPLEMENT",
                status: "QUEUED",
              },
            },
            {
              issueNumber: 9,
              outcome: "FAILED",
              workItem: {
                id: "wi-9",
                state: "IMPLEMENT",
                status: "FAILED",
              },
              error: {
                code: "ACTIVE_STEP_RUN_EXISTS",
                message: "Work Item wi-9 already has an active Step Run",
              },
            },
          ],
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  test("retry GraphQL operation failure preserves extensions.code on stderr", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: null,
            errors: [
              {
                message:
                  "Work Item wi-9 does not belong to repository repo-process-1",
                extensions: { code: "WORK_ITEM_NOT_IN_REPOSITORY" },
              },
            ],
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["retry", "github.com/owner/repo", "--work-item", "wi-9"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stderr)).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "retry",
        error: {
          code: "WORK_ITEM_NOT_IN_REPOSITORY",
          message:
            "Work Item wi-9 does not belong to repository repo-process-1",
        },
      })
    } finally {
      await closeServer(server)
    }
  })

  test("intake GraphQL operation failure preserves extensions.code on stderr", async () => {
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: null,
            errors: [
              {
                message: "Agent Backend is unavailable",
                extensions: { code: "AGENT_BACKEND_UNAVAILABLE" },
              },
            ],
          }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["intake", "github.com/owner/repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stderr)).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "intake",
        error: {
          code: "AGENT_BACKEND_UNAVAILABLE",
          message: "Agent Backend is unavailable",
        },
      })
    } finally {
      await closeServer(server)
    }
  })

  test("status without repository emits six empty lanes on stdout", async () => {
    const emptyStatusLanes = [
      { id: "QUEUE" as const, label: "Queue", count: 0, workItems: [] },
      { id: "BUILD" as const, label: "Build", count: 0, workItems: [] },
      { id: "REVIEW" as const, label: "Review", count: 0, workItems: [] },
      { id: "PR" as const, label: "PR", count: 0, workItems: [] },
      { id: "ATTENTION" as const, label: "Attention", count: 0, workItems: [] },
      { id: "MERGED" as const, label: "Merged", count: 0, workItems: [] },
    ]
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
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("kanbanStatus")) {
          res.end(
            JSON.stringify({
              data: {
                kanbanStatus: {
                  repository: null,
                  lanes: emptyStatusLanes,
                },
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({ data: null, errors: [{ message: "unexpected" }] }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["status"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe("")
      expect(parseExactlyOneJsonDocument(result.stdout)).toEqual(
        buildStatusSuccessDocument({
          repository: null,
          lanes: emptyStatusLanes,
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  test("status with repository selector resolves then queries kanbanStatus", async () => {
    const emptyStatusLanes = [
      { id: "QUEUE" as const, label: "Queue", count: 0, workItems: [] },
      { id: "BUILD" as const, label: "Build", count: 0, workItems: [] },
      { id: "REVIEW" as const, label: "Review", count: 0, workItems: [] },
      { id: "PR" as const, label: "PR", count: 0, workItems: [] },
      { id: "ATTENTION" as const, label: "Attention", count: 0, workItems: [] },
      { id: "MERGED" as const, label: "Merged", count: 0, workItems: [] },
    ]
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
        const body = Buffer.concat(chunks).toString("utf8")
        seenBodies.push(body)
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("repositories")) {
          res.end(
            JSON.stringify({
              data: {
                repositories: [
                  {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                ],
              },
            }),
          )
          return
        }
        if (body.includes("kanbanStatus")) {
          res.end(
            JSON.stringify({
              data: {
                kanbanStatus: {
                  repository: {
                    id: "repo-process-1",
                    forge: "github",
                    forgeHost: "github.com",
                    projectPath: "owner/repo",
                  },
                  lanes: emptyStatusLanes,
                },
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({ data: null, errors: [{ message: "unexpected" }] }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["status", "github.com/owner/repo"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe("")
      expect(seenBodies.some((body) => body.includes("repositories"))).toBe(
        true,
      )
      expect(seenBodies.some((body) => body.includes("kanbanStatus"))).toBe(
        true,
      )
      expect(parseExactlyOneJsonDocument(result.stdout)).toEqual(
        buildStatusSuccessDocument({
          repository: {
            id: "repo-process-1",
            forge: "github",
            forgeHost: "github.com",
            projectPath: "owner/repo",
          },
          lanes: emptyStatusLanes,
        }),
      )
    } finally {
      await closeServer(server)
    }
  })

  test("status keeps schemaVersion 1 and carries canRetry plus latest Step Run reason", async () => {
    const repository = {
      id: "repo-process-1",
      forge: "github",
      forgeHost: "github.com",
      projectPath: "owner/repo",
    }
    const graphqlWorkItems = [
      {
        repository,
        workItem: {
          id: "wi-retryable-failed",
          issueNumber: 10,
          issueTitle: "Retryable implement failure",
          state: "IMPLEMENT",
          status: "FAILED",
          statusLabel: "Failed",
          statusMessage: "Claude Code failed to implement the Work Item issue",
          paused: false,
          canRetry: true,
          latestStepRunReason: {
            code: "handler_failed",
            message: "Claude Code failed to implement the Work Item issue",
            retryAt: null,
            detail: {
              code: "ENOENT",
              causeChain: [
                {
                  name: "Error",
                  code: "ENOENT",
                  message: 'ENOENT: Executable not found in $PATH: "claude"',
                },
              ],
            },
          },
          pullRequestNumber: null,
          createdAt: "2026-08-12T10:00:00.000Z",
          updatedAt: "2026-08-12T10:00:00.000Z",
          stateReadyAt: "2026-08-12T10:00:00.000Z",
          postponedUntil: null,
        },
      },
      {
        repository,
        workItem: {
          id: "wi-terminal-failed",
          issueNumber: 11,
          issueTitle: "Terminal close failure",
          state: "FAILED",
          status: "FAILED",
          statusLabel: "Failed",
          statusMessage: "Issue is not open",
          paused: false,
          canRetry: false,
          latestStepRunReason: {
            code: "issue_not_open",
            message: "Issue is not open",
            detail: null,
            retryAt: null,
          },
          pullRequestNumber: null,
          createdAt: "2026-08-12T10:00:00.000Z",
          updatedAt: "2026-08-12T10:00:00.000Z",
          stateReadyAt: "2026-08-12T10:00:00.000Z",
          postponedUntil: null,
        },
      },
      {
        repository,
        workItem: {
          id: "wi-retryable-needs-human",
          issueNumber: 12,
          issueTitle: "Retryable review handoff",
          state: "NEEDS_HUMAN",
          status: "NEEDS_HUMAN",
          statusLabel: "Needs human",
          statusMessage: "Human must review findings",
          paused: false,
          canRetry: true,
          latestStepRunReason: {
            code: "review_accepted",
            message: "Human must review findings",
            detail: null,
            retryAt: null,
          },
          pullRequestNumber: null,
          createdAt: "2026-08-12T10:00:00.000Z",
          updatedAt: "2026-08-12T10:00:00.000Z",
          stateReadyAt: "2026-08-12T10:00:00.000Z",
          postponedUntil: null,
        },
      },
      {
        repository,
        workItem: {
          id: "wi-unavailable-detail",
          issueNumber: 13,
          issueTitle: "Interrupted without detail",
          state: "IMPLEMENT",
          status: "INTERRUPTED",
          statusLabel: "Interrupted",
          statusMessage:
            "Lifecycle Step was interrupted before an outcome could be established",
          paused: false,
          canRetry: true,
          latestStepRunReason: {
            code: "interrupted",
            message:
              "Lifecycle Step was interrupted before an outcome could be established",
            detail: null,
            retryAt: null,
          },
          pullRequestNumber: null,
          createdAt: "2026-08-12T10:00:00.000Z",
          updatedAt: "2026-08-12T10:00:00.000Z",
          stateReadyAt: "2026-08-12T10:00:00.000Z",
          postponedUntil: null,
        },
      },
      {
        repository,
        workItem: {
          id: "wi-draining",
          issueNumber: 14,
          issueTitle: "Paused while Build is still running",
          state: "IMPLEMENT",
          status: "NEEDS_HUMAN_REVIEW",
          statusLabel: "Draining",
          statusMessage: null,
          paused: true,
          canRetry: false,
          latestStepRunReason: null,
          pullRequestNumber: null,
          createdAt: "2026-08-12T10:00:00.000Z",
          updatedAt: "2026-08-12T10:00:00.000Z",
          stateReadyAt: "2026-08-12T10:00:00.000Z",
          postponedUntil: null,
        },
      },
    ]
    const graphqlLanes = [
      { id: "QUEUE", label: "Queue", count: 0, workItems: [] },
      { id: "BUILD", label: "Build", count: 0, workItems: [] },
      { id: "REVIEW", label: "Review", count: 0, workItems: [] },
      { id: "PR", label: "PR", count: 0, workItems: [] },
      {
        id: "ATTENTION",
        label: "Attention",
        count: graphqlWorkItems.length,
        workItems: graphqlWorkItems,
      },
      { id: "MERGED", label: "Merged", count: 0, workItems: [] },
    ]
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
        const body = Buffer.concat(chunks).toString("utf8")
        seenBodies.push(body)
        res.writeHead(200, { "content-type": "application/json" })
        if (body.includes("kanbanStatus")) {
          res.end(
            JSON.stringify({
              data: {
                kanbanStatus: {
                  repository: null,
                  lanes: graphqlLanes,
                },
              },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({ data: null, errors: [{ message: "unexpected" }] }),
        )
      })
    })

    try {
      const port = await listen(server)
      const result = await runCli(
        ["status"],
        `http://127.0.0.1:${port}/graphql`,
      )

      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe("")
      expect(seenBodies.some((body) => body.includes("canRetry"))).toBe(true)
      expect(
        seenBodies.some((body) => body.includes("latestStepRunReason")),
      ).toBe(true)
      expect(seenBodies.some((body) => body.includes("statusLabel"))).toBe(true)
      const document = parseExactlyOneJsonDocument(result.stdout)
      expect(document).toEqual(
        buildStatusSuccessDocument({
          repository: null,
          lanes: graphqlLanes.map((lane) => ({
            id: lane.id as
              | "QUEUE"
              | "BUILD"
              | "REVIEW"
              | "PR"
              | "ATTENTION"
              | "MERGED",
            label: lane.label,
            count: lane.count,
            workItems: lane.workItems.map((row) => ({
              repository: row.repository,
              ...row.workItem,
            })),
          })),
        }),
      )
      expect(document).toMatchObject({ schemaVersion: CLI_SCHEMA_VERSION })
      expect(CLI_SCHEMA_VERSION).toBe(1)
    } finally {
      await closeServer(server)
    }
  })

  test("status against unreachable GraphQL emits JSON error on stderr only", async () => {
    const result = await runCli(["status"], "http://127.0.0.1:1/graphql")

    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe("")
    expect(parseExactlyOneJsonDocument(result.stderr)).toEqual({
      schemaVersion: CLI_SCHEMA_VERSION,
      command: "status",
      error: {
        code: HARNESS_UNREACHABLE_CODE,
        message: harnessNotRunningMessage("http://127.0.0.1:1"),
      },
    })
  })

  test("status against HTML at the configured URL emits GRAPHQL_URL_NOT_ENDPOINT once", async () => {
    let requestCount = 0
    const seenUrls: string[] = []
    const server = createServer((req, res) => {
      requestCount += 1
      seenUrls.push(req.url ?? "")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end("<!doctype html><html><body>Harness</body></html>")
    })

    try {
      const port = await listen(server)
      const graphqlUrl = `http://127.0.0.1:${port}`
      const result = await runCli(["status"], graphqlUrl)

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(requestCount).toBe(1)
      expect(seenUrls).toEqual(["/"])
      expect(parseExactlyOneJsonDocument(result.stderr)).toEqual({
        schemaVersion: CLI_SCHEMA_VERSION,
        command: "status",
        error: {
          code: GRAPHQL_URL_NOT_ENDPOINT_CODE,
          message: `${graphqlUrl} returned HTML (the Harness UI), not GraphQL. Set READY_FOR_AGENT_GRAPHQL_URL=${graphqlUrl}/graphql`,
        },
      })
      expect(result.stderr).not.toContain("Failed to parse JSON")
      expect(result.stderr).not.toContain("GRAPHQL_ERROR")
    } finally {
      await closeServer(server)
    }
  })
})

const jumpSessionId = "85312e9f-9c57-42ef-9757-b2512cee57cd"

const writeExecutable = (path: string, body: string): void => {
  writeFileSync(path, body, { encoding: "utf8" })
  chmodSync(path, 0o755)
}

const parseTmuxArgvLog = (logPath: string): readonly (readonly string[])[] => {
  const text = readFileSync(logPath, "utf8").trim()
  if (text.length === 0) {
    return []
  }
  return text.split("\n").map((line) => JSON.parse(line) as string[])
}

const ptyRunnerSource = `import os
import pty
import sys

stderr_path = os.environ.pop("RFA_PTY_STDERR", "")
sigint_after = os.environ.pop("RFA_PTY_SEND_SIGINT_AFTER", "")
cmd = sys.argv[1:]
if len(cmd) == 0:
    sys.exit(2)

def copy_master(master: int) -> None:
    sent = False
    buf = b""
    while True:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
        if sigint_after and not sent:
            buf += data
            if sigint_after.encode() in buf:
                os.write(master, b"\\x03")
                sent = True

if stderr_path:
    master, slave = pty.openpty()
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        err = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        os.dup2(err, 2)
        os.close(err)
        os.close(slave)
        os.execvpe(cmd[0], cmd, os.environ)
        os._exit(127)
    os.close(slave)
    copy_master(master)
    _, status = os.waitpid(pid, 0)
    os.close(master)
    sys.exit(os.waitstatus_to_exitcode(status))

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, os.environ)
    os._exit(127)
copy_master(fd)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`

const recordingBackendScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs"

const recordPath = process.env.BACKEND_RECORD
if (recordPath !== undefined && recordPath.length > 0) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      argv1: process.argv[1],
      cwd: process.cwd(),
      envMarker: process.env.RFA_DIRECT_MARKER ?? null,
      sqliteDatabasePath: process.env.SQLITE_DATABASE_PATH ?? null,
      keymaxxerSidecarUrl: process.env.KEYMAXXER_SIDECAR_URL ?? null,
      graphqlUrl: process.env.READY_FOR_AGENT_GRAPHQL_URL ?? null,
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      stderrIsTTY: Boolean(process.stderr.isTTY),
    }),
  )
}

if (process.env.BACKEND_IGNORE_SIGINT === "1") {
  process.on("SIGINT", () => {})
}

process.stdout.write("backend-ready\\n")

if (process.env.BACKEND_STDERR_TEXT !== undefined) {
  process.stderr.write(process.env.BACKEND_STDERR_TEXT)
}

const signal = process.env.BACKEND_SIGNAL
if (process.env.BACKEND_IGNORE_SIGINT === "1") {
  setTimeout(() => process.exit(0), 400)
} else if (signal !== undefined && signal.length > 0) {
  process.kill(process.pid, signal)
} else {
  process.exit(Number(process.env.BACKEND_EXIT ?? "0"))
}
`

type BackendRecord = {
  readonly argv: readonly string[]
  readonly argv1: string
  readonly cwd: string
  readonly envMarker: string | null
  readonly sqliteDatabasePath: string | null
  readonly keymaxxerSidecarUrl: string | null
  readonly graphqlUrl: string | null
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly stderrIsTTY: boolean
}

const readBackendRecord = (path: string): BackendRecord =>
  JSON.parse(readFileSync(path, "utf8")) as BackendRecord

const runCliOnPty = (
  args: readonly string[],
  graphqlUrl: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options: {
    readonly stderrPath?: string
    readonly sendSigintAfter?: string
  } = {},
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      READY_FOR_AGENT_GRAPHQL_URL: graphqlUrl,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...extraEnv,
    }
    if (!("TMUX" in extraEnv)) {
      delete env.TMUX
    }
    const bunArgs = [
      process.execPath,
      "--conditions",
      "@ready-for-agent/source",
      "src/main.ts",
      ...args,
    ]
    if (options.stderrPath !== undefined) {
      env.RFA_PTY_STDERR = options.stderrPath
    } else {
      delete env.RFA_PTY_STDERR
    }
    if (options.sendSigintAfter !== undefined) {
      env.RFA_PTY_SEND_SIGINT_AFTER = options.sendSigintAfter
    } else {
      delete env.RFA_PTY_SEND_SIGINT_AFTER
    }
    const python = Bun.which("python3") ?? "python3"
    const child = spawn(python, ["-c", ptyRunnerSource, ...bunArgs], {
      cwd: packageRoot,
      env,
    })
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
      reject(
        new Error(
          `pty ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
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

const startJumpGraphqlServer = (options: {
  readonly backendId?: string
  readonly worktreePath?: string | null
  readonly agentModel?: string | null
  readonly thinkingLevel?: string | null
  readonly error?: { readonly code: string; readonly message: string }
}): Promise<{
  readonly url: string
  readonly seenBodies: string[]
  readonly close: () => Promise<void>
}> =>
  new Promise((resolve, reject) => {
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
        if (options.error !== undefined) {
          res.end(
            JSON.stringify({
              data: null,
              errors: [
                {
                  message: options.error.message,
                  extensions: { code: options.error.code },
                },
              ],
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            data: {
              workItemBySessionId: {
                agentBackend: {
                  id: options.backendId ?? "opencode",
                  label: options.backendId ?? "OpenCode",
                },
                sessionId: jumpSessionId,
                worktreePath: options.worktreePath ?? null,
                agentModel: options.agentModel ?? null,
                thinkingLevel: options.thinkingLevel ?? null,
              },
            },
          }),
        )
      })
    })
    listen(server)
      .then((port) => {
        resolve({
          url: `http://127.0.0.1:${port}/graphql`,
          seenBodies,
          close: () => closeServer(server),
        })
      })
      .catch(reject)
  })

describe("operator binary jump process contract", () => {
  let tempRoot = ""
  let binDir = ""
  let tmuxLog = ""

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-jump-process-"))
    binDir = join(tempRoot, "bin")
    mkdirSync(binDir)
    tmuxLog = join(tempRoot, "tmux-argv.log")
    writeFileSync(tmuxLog, "")
    writeExecutable(
      join(binDir, "tmux"),
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.TMUX_ARGV_LOG ?? "", JSON.stringify(args) + "\\n")
if (process.env.TMUX_FAIL === "1") {
  process.exit(1)
}
if (process.env.TMUX_FAIL_ON !== undefined && args.includes(process.env.TMUX_FAIL_ON)) {
  process.exit(1)
}
if (args[0] === "display-message") {
  process.stdout.write((process.env.TMUX_CURRENT_SESSION ?? "$0") + "\\n")
  process.exit(0)
}
if (args[0] === "list-windows") {
  process.stdout.write((process.env.TMUX_LIST_WINDOWS ?? "") + "\\n")
  process.exit(0)
}
if (args[0] === "list-panes") {
  process.stdout.write((process.env.TMUX_LIST_PANES ?? "%1 1\\n%2") + "\\n")
  process.exit(0)
}
if (args.includes("new-window")) {
  process.stdout.write("@1 %1\\n")
  process.exit(0)
}
if (args[0] === "split-window" && args.includes("-P")) {
  process.stdout.write("%3\\n")
  process.exit(0)
}
`,
    )
    for (const name of ["opencode", "grok", "codex", "claude"] as const) {
      writeExecutable(join(binDir, name), recordingBackendScript)
    }
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const jumpEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMUX: "/tmp/tmux-1000/default,123,0",
    TMUX_PANE: "%9",
    TERM: "xterm-256color",
    PWD: "/tmp/wrong-pwd",
    CLAUDE_CODE_USE_BEDROCK: "1",
    TMUX_ARGV_LOG: tmuxLog,
    ...overrides,
  })

  const omittedTmuxEnvPrefixes = [
    "TMUX=",
    "TMUX_PANE=",
    "TERM=",
    "PWD=",
  ] as const

  const tmuxFlagEnvAssignments = (
    args: readonly string[],
  ): readonly string[] => {
    const separator = args.indexOf("--")
    const limit = separator === -1 ? args.length : separator
    const assignments: string[] = []
    for (let i = 0; i < limit; i++) {
      if (args[i] !== "-e") {
        continue
      }
      const assignment = args[i + 1]
      if (assignment !== undefined) {
        assignments.push(assignment)
      }
      i += 1
    }
    return assignments
  }

  const withoutTmuxEnvFlags = (args: readonly string[]): string[] => {
    const out: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e") {
        i += 1
        continue
      }
      const arg = args[i]
      if (arg !== undefined) {
        out.push(arg)
      }
    }
    return out
  }

  const expectForwardedPaneEnvironment = (args: readonly string[]) => {
    const assignments = tmuxFlagEnvAssignments(args)
    expect(assignments).toContain("CLAUDE_CODE_USE_BEDROCK=1")
    for (const prefix of omittedTmuxEnvPrefixes) {
      expect(
        assignments.some((assignment) => assignment.startsWith(prefix)),
      ).toBe(false)
    }
    const separator = args.indexOf("--")
    const firstEnv = args.indexOf("-e")
    expect(firstEnv).toBeGreaterThan(-1)
    expect(separator).toBeGreaterThan(firstEnv)
  }

  test("jump without a TTY rejects before contacting the Harness or tmux", async () => {
    const result = await runCli(
      ["jump", jumpSessionId],
      "http://127.0.0.1:1/graphql",
    )

    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe("")
    expect(result.stderr.trim()).toBe("jump requires an interactive terminal")
    expect(result.stderr).not.toContain("schemaVersion")
    expect(result.stderr).not.toMatch(/\s+at\s+\S+\s+\(/)
    expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
  })

  test("jump with an empty TMUX still selects direct mode", async () => {
    const result = await runCli(
      ["jump", jumpSessionId],
      "http://127.0.0.1:1/graphql",
      { TMUX: "" },
    )

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe("jump requires an interactive terminal")
    expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
  })

  test("jump against unreachable GraphQL writes text, not JSON", async () => {
    const result = await runCli(
      ["jump", jumpSessionId],
      "http://127.0.0.1:1/graphql",
      jumpEnv(),
    )

    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe("")
    expect(result.stderr).toContain(
      harnessNotRunningMessage("http://127.0.0.1:1"),
    )
    expect(result.stderr).not.toContain("schemaVersion")
    expect(result.stderr).not.toContain("HARNESS_UNREACHABLE")
    expect(result.stderr).not.toMatch(/\s+at\s+\S+\s+\(/)
    expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
  })

  test("jump writes the Session-not-found GraphQL message", async () => {
    const graphql = await startJumpGraphqlServer({
      error: {
        code: "SESSION_NOT_FOUND",
        message: `No Work Item owns Session ID: ${jumpSessionId}`,
      },
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv(),
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(result.stderr.trim()).toBe(
        `No Work Item owns Session ID: ${jumpSessionId}`,
      )
      expect(
        graphql.seenBodies.some((body) => body.includes("workItemBySessionId")),
      ).toBe(true)
      expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
    } finally {
      await graphql.close()
    }
  })

  test("jump writes the ambiguous-Session GraphQL message", async () => {
    const graphql = await startJumpGraphqlServer({
      error: {
        code: "SESSION_AMBIGUOUS",
        message: `Multiple Work Items own Session ID: ${jumpSessionId}`,
      },
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv(),
      )

      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(
        `Multiple Work Items own Session ID: ${jumpSessionId}`,
      )
    } finally {
      await graphql.close()
    }
  })

  test("jump fails when the captured Agent Backend is unsupported", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "mystery",
      worktreePath: null,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv(),
      )

      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe("Unsupported Agent Backend: mystery")
      expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
    } finally {
      await graphql.close()
    }
  })

  test("jump fails when the backend executable is not on PATH", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const emptyBin = join(tempRoot, "empty-bin")
      mkdirSync(emptyBin)
      const bunDir = dirname(Bun.which("bun") ?? "/usr/bin/bun")
      const result = await runCli(["jump", jumpSessionId], graphql.url, {
        PATH: `${emptyBin}:${bunDir}`,
        TMUX: "/tmp/tmux-1000/default,123,0",
        TMUX_ARGV_LOG: tmuxLog,
      })

      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(
        "Agent Backend executable 'opencode' is not on PATH",
      )
      expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
    } finally {
      await graphql.close()
    }
  })

  test("jump fails when tmux cannot create the window", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv({ TMUX_FAIL: "1" }),
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(result.stderr).toContain(
        "tmux could not create and arrange the window",
      )
    } finally {
      await graphql.close()
    }
  })

  test("jump creates an even split with the resolved OpenCode executable", async () => {
    const worktree = join(tempRoot, "worktree")
    mkdirSync(worktree)
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: worktree,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv(),
      )

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe("")
      expect(result.stderr.trim()).toBe("")
      const invocations = parseTmuxArgvLog(tmuxLog)
      const opencode = join(binDir, "opencode")
      const created = invocations.find((args) => args.includes("new-window"))
      expect(created).toBeDefined()
      if (created !== undefined) {
        expectForwardedPaneEnvironment(created)
      }
      expect(invocations.map(withoutTmuxEnvFlags)).toEqual([
        ["display-message", "-p", "#{session_id}"],
        [
          "list-windows",
          "-a",
          "-F",
          "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{@rfa-session-id}",
        ],
        [
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_id} #{pane_id}",
          "-n",
          "rfa:85312e9f",
          "-c",
          worktree,
          "--",
          opencode,
          worktree,
          "--session",
          jumpSessionId,
          "--auto",
        ],
        ["set-option", "-w", "-t", "@1", "@rfa-session-id", jumpSessionId],
        ["set-option", "-p", "-t", "%1", "@rfa-agent", "1"],
        ["split-window", "-h", "-t", "@1", "-c", worktree],
        ["select-layout", "-t", "@1", "even-horizontal"],
        ["select-pane", "-t", "%1"],
        ["select-window", "-t", "@1"],
      ])
    } finally {
      await graphql.close()
    }
  })

  test("jump pins the Work Item Agent Model on the OpenCode pane command", async () => {
    const worktree = join(tempRoot, "worktree-model")
    mkdirSync(worktree)
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: worktree,
      agentModel: "amazon-bedrock/au.anthropic.claude-sonnet-5",
      thinkingLevel: "high",
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv(),
      )

      expect(result.status).toBe(0)
      const invocations = parseTmuxArgvLog(tmuxLog)
      const opencode = join(binDir, "opencode")
      expect(invocations.map(withoutTmuxEnvFlags)).toContainEqual([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id} #{pane_id}",
        "-n",
        "rfa:85312e9f",
        "-c",
        worktree,
        "--",
        opencode,
        worktree,
        "--session",
        jumpSessionId,
        "--auto",
        "-m",
        "amazon-bedrock/au.anthropic.claude-sonnet-5",
      ])
    } finally {
      await graphql.close()
    }
  })

  test("jump uses the CLI cwd when the worktree is gone", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "claude",
      worktreePath: join(tempRoot, "cleaned-up-worktree"),
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv(),
      )

      expect(result.status).toBe(0)
      const invocations = parseTmuxArgvLog(tmuxLog)
      const claude = join(binDir, "claude")
      const cliCwd = resolve(packageRoot)
      expect(invocations[2]).toBeDefined()
      if (invocations[2] !== undefined) {
        expectForwardedPaneEnvironment(invocations[2])
        expect(tmuxFlagEnvAssignments(invocations[2])).toContain(
          "DISABLE_AUTOUPDATER=1",
        )
      }
      expect(withoutTmuxEnvFlags(invocations[2] ?? [])).toEqual([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id} #{pane_id}",
        "-n",
        "rfa:85312e9f",
        "-c",
        cliCwd,
        "--",
        claude,
        "--resume",
        jumpSessionId,
        "--dangerously-skip-permissions",
      ])
      expect(invocations).toContainEqual([
        "split-window",
        "-h",
        "-t",
        "@1",
        "-c",
        cliCwd,
      ])
    } finally {
      await graphql.close()
    }
  })

  test("jump launches Grok and Codex interactive resume commands", async () => {
    const worktree = join(tempRoot, "backend-wt")
    mkdirSync(worktree)
    for (const [backendId, expectedTail] of [
      [
        "grok",
        [
          "--cwd",
          worktree,
          "--resume",
          jumpSessionId,
          "--permission-mode",
          "bypassPermissions",
        ],
      ],
      [
        "codex",
        [
          "resume",
          "--dangerously-bypass-approvals-and-sandbox",
          "-C",
          worktree,
          jumpSessionId,
        ],
      ],
    ] as const) {
      writeFileSync(tmuxLog, "")
      const graphql = await startJumpGraphqlServer({
        backendId,
        worktreePath: worktree,
      })
      try {
        const result = await runCli(
          ["jump", jumpSessionId],
          graphql.url,
          jumpEnv(),
        )
        expect(result.status).toBe(0)
        const invocations = parseTmuxArgvLog(tmuxLog)
        const created = invocations.find((args) => args[0] === "new-window")
        const separator = created?.indexOf("--") ?? -1
        expect(created?.slice(separator + 1)).toEqual([
          join(binDir, backendId),
          ...expectedTail,
        ])
      } finally {
        await graphql.close()
      }
    }
  })

  test("jump selects the existing tagged window instead of creating another", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCli(["jump", jumpSessionId], graphql.url, {
        ...jumpEnv(),
        TMUX_LIST_WINDOWS: `$0\tdefault\t@5\t3\t${jumpSessionId}`,
        TMUX_LIST_PANES: "%1 1\n%2",
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe("")
      expect(result.stderr.trim()).toBe("")
      const invocations = parseTmuxArgvLog(tmuxLog)
      expect(invocations.some((args) => args.includes("new-window"))).toBe(
        false,
      )
      expect(invocations).toContainEqual(["select-window", "-t", "@5"])
      expect(invocations).toContainEqual(["select-pane", "-t", "%1"])
    } finally {
      await graphql.close()
    }
  })

  test("jump recreates the left agent pane when only the shell remains", async () => {
    const worktree = join(tempRoot, "reuse-worktree")
    mkdirSync(worktree)
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: worktree,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv({
          TMUX_LIST_WINDOWS: `$0\tdefault\t@5\t3\t${jumpSessionId}`,
          TMUX_LIST_PANES: "%2",
        }),
      )

      expect(result.status).toBe(0)
      const invocations = parseTmuxArgvLog(tmuxLog)
      expect(invocations.some((args) => args.includes("new-window"))).toBe(
        false,
      )
      const recreated = invocations.find(
        (args) => args[0] === "split-window" && args.includes("-P"),
      )
      expect(recreated).toBeDefined()
      if (recreated !== undefined) {
        expectForwardedPaneEnvironment(recreated)
      }
      expect(invocations.map(withoutTmuxEnvFlags)).toContainEqual([
        "split-window",
        "-h",
        "-b",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "@5",
        "-c",
        worktree,
        "--",
        join(binDir, "opencode"),
        worktree,
        "--session",
        jumpSessionId,
        "--auto",
      ])
      expect(invocations).toContainEqual([
        "set-option",
        "-p",
        "-t",
        "%3",
        "@rfa-agent",
        "1",
      ])
      expect(invocations).toContainEqual([
        "select-layout",
        "-t",
        "@5",
        "even-horizontal",
      ])
      expect(invocations).toContainEqual(["select-pane", "-t", "%3"])
    } finally {
      await graphql.close()
    }
  })

  test("jump reuses a sole remaining tagged agent pane", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv({
          TMUX_LIST_WINDOWS: `$0\tdefault\t@5\t3\t${jumpSessionId}`,
          TMUX_LIST_PANES: "%1 1",
        }),
      )

      expect(result.status).toBe(0)
      const invocations = parseTmuxArgvLog(tmuxLog)
      expect(invocations.some((args) => args.includes("new-window"))).toBe(
        false,
      )
      expect(invocations.some((args) => args.includes("split-window"))).toBe(
        false,
      )
      expect(invocations).toContainEqual(["select-pane", "-t", "%1"])
      expect(invocations).toContainEqual(["select-window", "-t", "@5"])
    } finally {
      await graphql.close()
    }
  })

  test("jump does not kill the created window when only select-window fails", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv({ TMUX_FAIL_ON: "select-window" }),
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        "tmux could not create and arrange the window",
      )
      const invocations = parseTmuxArgvLog(tmuxLog)
      expect(invocations.some((args) => args.includes("new-window"))).toBe(true)
      expect(invocations.some((args) => args.includes("kill-window"))).toBe(
        false,
      )
    } finally {
      await graphql.close()
    }
  })

  test("jump refuses a tagged window that belongs to another tmux session", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv({
          TMUX_LIST_WINDOWS: `$1\tother\t@8\t2\t${jumpSessionId}`,
        }),
      )

      expect(result.status).toBe(1)
      expect(result.stdout.trim()).toBe("")
      expect(result.stderr.trim()).toBe(
        "Session already open in tmux session 'other' window 2",
      )
      const invocations = parseTmuxArgvLog(tmuxLog)
      expect(invocations.some((args) => args.includes("new-window"))).toBe(
        false,
      )
    } finally {
      await graphql.close()
    }
  })

  test("jump kills only the window it created when split-window fails", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        jumpEnv({ TMUX_FAIL_ON: "split-window" }),
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        "tmux could not create and arrange the window",
      )
      const invocations = parseTmuxArgvLog(tmuxLog)
      expect(invocations.some((args) => args.includes("new-window"))).toBe(true)
      expect(invocations.at(-1)).toEqual(["kill-window", "-t", "@1"])
    } finally {
      await graphql.close()
    }
  })
})

describe("operator binary jump direct process contract", () => {
  let tempRoot = ""
  let binDir = ""
  let tmuxLog = ""
  let backendRecord = ""

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-jump-direct-"))
    binDir = join(tempRoot, "bin")
    mkdirSync(binDir)
    tmuxLog = join(tempRoot, "tmux-argv.log")
    backendRecord = join(tempRoot, "backend-record.json")
    writeFileSync(tmuxLog, "")
    writeExecutable(
      join(binDir, "tmux"),
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
appendFileSync(process.env.TMUX_ARGV_LOG ?? "", JSON.stringify(process.argv.slice(2)) + "\\n")
process.exit(1)
`,
    )
    for (const name of ["opencode", "grok", "codex", "claude"] as const) {
      writeExecutable(join(binDir, name), recordingBackendScript)
    }
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const directEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: `${binDir}:${dirname(process.execPath)}`,
    TMUX_ARGV_LOG: tmuxLog,
    BACKEND_RECORD: backendRecord,
    RFA_DIRECT_MARKER: "from-parent",
    SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
    KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
    ...overrides,
  })

  const expectedResumeArgs = {
    opencode: (workingDirectory: string) => [
      workingDirectory,
      "--session",
      jumpSessionId,
      "--auto",
    ],
    grok: (workingDirectory: string) => [
      "--cwd",
      workingDirectory,
      "--resume",
      jumpSessionId,
      "--permission-mode",
      "bypassPermissions",
    ],
    codex: (workingDirectory: string) => [
      "resume",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      workingDirectory,
      jumpSessionId,
    ],
    claude: (_workingDirectory: string) => [
      "--resume",
      jumpSessionId,
      "--dangerously-skip-permissions",
    ],
  } as const

  test("jump help describes Interactive Session Continuation without requiring tmux", async () => {
    const result = await runCli(
      ["jump", "--help"],
      "http://127.0.0.1:1/graphql",
    )

    expect(result.status).toBe(0)
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).toContain("Interactive Session Continuation")
    expect(output.toLowerCase()).not.toContain("must be run from inside a tmux")
    expect(output).not.toContain("new tmux window")
  })

  test("jump continues each backend directly outside tmux", async () => {
    const worktree = join(tempRoot, "worktree")
    mkdirSync(worktree)

    for (const backendId of ["opencode", "grok", "codex", "claude"] as const) {
      writeFileSync(backendRecord, "")
      writeFileSync(tmuxLog, "")
      const graphql = await startJumpGraphqlServer({
        backendId,
        worktreePath: worktree,
      })
      try {
        const result = await runCliOnPty(
          ["jump", jumpSessionId],
          graphql.url,
          directEnv(),
        )

        expect(result.status).toBe(0)
        expect(result.stdout.replaceAll("\r", "")).toContain("backend-ready")
        expect(result.stdout).not.toContain("Continuing")
        expect(result.stdout).not.toContain("Session continued")
        expect(result.stderr.replaceAll("\r", "").trim()).toBe("")
        expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
        const record = readBackendRecord(backendRecord)
        expect(record.argv1).toBe(join(binDir, backendId))
        expect(record.argv).toEqual(expectedResumeArgs[backendId](worktree))
        expect(record.cwd).toBe(worktree)
        expect(record.envMarker).toBe("from-parent")
        expect(record.sqliteDatabasePath).toBeNull()
        expect(record.keymaxxerSidecarUrl).toBeNull()
        expect(record.graphqlUrl).toBeNull()
        expect(record.stdinIsTTY).toBe(true)
        expect(record.stdoutIsTTY).toBe(true)
      } finally {
        await graphql.close()
      }
    }
  })

  test("jump uses the CLI cwd when the worktree is gone in direct mode", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "claude",
      worktreePath: join(tempRoot, "cleaned-up-worktree"),
    })
    try {
      const result = await runCliOnPty(
        ["jump", jumpSessionId],
        graphql.url,
        directEnv(),
      )

      expect(result.status).toBe(0)
      expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
      const record = readBackendRecord(backendRecord)
      expect(record.cwd).toBe(resolve(packageRoot))
      expect(record.argv).toEqual(
        expectedResumeArgs.claude(resolve(packageRoot)),
      )
    } finally {
      await graphql.close()
    }
  })

  test("jump returns a nonzero backend exit without a Jump diagnostic", async () => {
    const worktree = join(tempRoot, "nonzero-wt")
    mkdirSync(worktree)
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: worktree,
    })
    try {
      const result = await runCliOnPty(
        ["jump", jumpSessionId],
        graphql.url,
        directEnv({ BACKEND_EXIT: "7" }),
      )

      expect(result.status).toBe(7)
      expect(result.stdout.replaceAll("\r", "")).toContain("backend-ready")
      expect(result.stderr.replaceAll("\r", "").trim()).toBe("")
      expect(result.stderr).not.toContain("jump")
    } finally {
      await graphql.close()
    }
  })

  test("jump returns a conventional signal-derived backend exit", async () => {
    const worktree = join(tempRoot, "signal-wt")
    mkdirSync(worktree)
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: worktree,
    })
    try {
      const result = await runCliOnPty(
        ["jump", jumpSessionId],
        graphql.url,
        directEnv({ BACKEND_SIGNAL: "SIGTERM" }),
      )

      expect(result.status).toBe(143)
      expect(result.stderr.replaceAll("\r", "").trim()).toBe("")
    } finally {
      await graphql.close()
    }
  })

  test("jump waits for a backend that survives a process-group SIGINT", async () => {
    const worktree = join(tempRoot, "sigint-wt")
    mkdirSync(worktree)
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: worktree,
    })
    try {
      const result = await runCliOnPty(
        ["jump", jumpSessionId],
        graphql.url,
        directEnv({ BACKEND_IGNORE_SIGINT: "1" }),
        { sendSigintAfter: "backend-ready" },
      )

      expect(result.status).toBe(0)
      expect(result.stdout.replaceAll("\r", "")).toContain("backend-ready")
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "could not start Agent Backend executable",
      )
    } finally {
      await graphql.close()
    }
  })

  test("jump allows redirected stderr when stdin and stdout are TTYs", async () => {
    const worktree = join(tempRoot, "stderr-wt")
    mkdirSync(worktree)
    const stderrPath = join(tempRoot, "redirected.err")
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: worktree,
    })
    try {
      const result = await runCliOnPty(
        ["jump", jumpSessionId],
        graphql.url,
        directEnv({ BACKEND_STDERR_TEXT: "backend-stderr\n" }),
        { stderrPath },
      )

      expect(result.status).toBe(0)
      expect(result.stdout.replaceAll("\r", "")).toContain("backend-ready")
      expect(readFileSync(stderrPath, "utf8")).toContain("backend-stderr")
      const record = readBackendRecord(backendRecord)
      expect(record.stdinIsTTY).toBe(true)
      expect(record.stdoutIsTTY).toBe(true)
      expect(record.stderrIsTTY).toBe(false)
    } finally {
      await graphql.close()
    }
  })

  test("jump spawn failure is a Jump-owned exit 1 after Session resolution", async () => {
    writeExecutable(join(binDir, "opencode"), "#!/no/such/interpreter\n")
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCliOnPty(
        ["jump", jumpSessionId],
        graphql.url,
        directEnv(),
      )

      expect(result.status).toBe(1)
      expect(
        graphql.seenBodies.some((body) => body.includes("workItemBySessionId")),
      ).toBe(true)
      const diagnostic = `${result.stdout}\n${result.stderr}`.replaceAll(
        "\r",
        "",
      )
      expect(diagnostic).toContain(
        `could not start Agent Backend executable '${join(binDir, "opencode")}'`,
      )
      expect(diagnostic).not.toContain("schemaVersion")
      expect(parseTmuxArgvLog(tmuxLog)).toEqual([])
    } finally {
      await graphql.close()
    }
  })

  test("a stale TMUX value stays on the tmux path and does not start the backend", async () => {
    const graphql = await startJumpGraphqlServer({
      backendId: "opencode",
      worktreePath: null,
    })
    try {
      const result = await runCli(
        ["jump", jumpSessionId],
        graphql.url,
        directEnv({
          TMUX: "/tmp/missing-tmux-socket,1,0",
        }),
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        "tmux could not create and arrange the window",
      )
      expect(parseTmuxArgvLog(tmuxLog).length).toBeGreaterThan(0)
      expect(() => readFileSync(backendRecord, "utf8")).toThrow()
    } finally {
      await graphql.close()
    }
  })
})
