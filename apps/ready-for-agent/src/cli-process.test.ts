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
import {
  CLI_SCHEMA_VERSION,
  buildAddSuccessDocument,
  buildCandidatesSuccessDocument,
  buildIntakeSuccessDocument,
  buildStatusSuccessDocument,
} from "./cli-json.ts"
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

const runCli = (
  args: readonly string[],
  graphqlUrl: string,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["--conditions", "@ready-for-agent/source", "src/main.ts", ...args],
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
})
