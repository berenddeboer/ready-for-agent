import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import {
  countOpenNonDraftPullRequestsLite,
  runOpenNonDraftPullRequestCountCli,
} from "../src/lib/open-non-draft-pull-request-count.js"

const encode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

const binScript = fileURLToPath(
  new URL("../src/bin/count-open-non-draft-pull-requests.ts", import.meta.url),
)

const bunExecutable = () =>
  process.execPath.includes("bun") ? process.execPath : "bun"

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

describe("countOpenNonDraftPullRequestsLite", () => {
  test("counts open non-draft PRs across pages and excludes drafts", async () => {
    const requests: unknown[] = []
    const pages = [
      {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                { isDraft: false },
                { isDraft: true },
                { isDraft: false },
              ],
              pageInfo: { endCursor: "c1", hasNextPage: true },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequests: {
              nodes: [{ isDraft: false }, null],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    ]

    const result = await countOpenNonDraftPullRequestsLite({
      token: "test-token",
      owner: "acme",
      name: "widgets",
      fetchImpl: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return jsonResponse(pages.shift()!)
      },
    })

    expect(result).toEqual({ _tag: "ok", count: 3 })
    expect(requests).toEqual([
      {
        query: expect.stringContaining("pullRequests"),
        variables: { owner: "acme", name: "widgets", after: null },
      },
      {
        query: expect.stringContaining("states: [OPEN]"),
        variables: { owner: "acme", name: "widgets", after: "c1" },
      },
    ])
  })

  test("returns zero when GitHub has no open non-draft PRs", async () => {
    const result = await countOpenNonDraftPullRequestsLite({
      token: "test-token",
      owner: "acme",
      name: "widgets",
      fetchImpl: async () =>
        jsonResponse({
          data: {
            repository: {
              pullRequests: {
                nodes: [{ isDraft: true }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        }),
    })
    expect(result).toEqual({ _tag: "ok", count: 0 })
  })

  test("reports repository unavailable when GitHub returns a null repository", async () => {
    const result = await countOpenNonDraftPullRequestsLite({
      token: "test-token",
      owner: "acme",
      name: "missing",
      fetchImpl: async () => jsonResponse({ data: { repository: null } }),
    })
    expect(result).toEqual({ _tag: "unavailable" })
  })

  test("retries GraphQL errors then fails without treating them as unavailable", async () => {
    let calls = 0
    const sleeps: number[] = []
    const result = await countOpenNonDraftPullRequestsLite({
      token: "test-token",
      owner: "acme",
      name: "widgets",
      sleepMs: async (ms) => {
        sleeps.push(ms)
      },
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({
          data: { repository: null },
          errors: [
            { message: "Something went wrong while executing your query." },
          ],
        })
      },
    })
    expect(result._tag).toBe("error")
    expect(calls).toBe(3)
    expect(sleeps).toEqual([500, 500])
    if (result._tag === "error") {
      expect(result.message).toContain("Something went wrong")
    }
  })

  test("does not retry HTTP 401 and preserves status on the error path", async () => {
    let calls = 0
    const result = await countOpenNonDraftPullRequestsLite({
      token: "bad-token",
      owner: "acme",
      name: "widgets",
      fetchImpl: async () => {
        calls += 1
        return new Response("Bad credentials", {
          status: 401,
          statusText: "Unauthorized",
        })
      },
    })
    expect(calls).toBe(1)
    expect(result._tag).toBe("error")
    if (result._tag === "error") {
      expect(result.statusCode).toBe(401)
      expect(result.message).not.toContain("bad-token")
    }
  })

  test("retries transient failures then succeeds", async () => {
    let calls = 0
    const sleeps: number[] = []
    const result = await countOpenNonDraftPullRequestsLite({
      token: "test-token",
      owner: "acme",
      name: "widgets",
      sleepMs: async (ms) => {
        sleeps.push(ms)
      },
      fetchImpl: async () => {
        calls += 1
        if (calls < 3) {
          return new Response("temporary", {
            status: 502,
            statusText: "Bad Gateway",
          })
        }
        return jsonResponse({
          data: {
            repository: {
              pullRequests: {
                nodes: [{ isDraft: false }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        })
      },
    })
    expect(result).toEqual({ _tag: "ok", count: 1 })
    expect(calls).toBe(3)
    expect(sleeps).toEqual([500, 500])
  })

  test("never includes the token in error messages", async () => {
    const secret = "ghp_super_secret_token_value"
    const result = await countOpenNonDraftPullRequestsLite({
      token: secret,
      owner: "acme",
      name: "widgets",
      sleepMs: async () => undefined,
      fetchImpl: async () => {
        throw new Error("network down")
      },
    })
    expect(result._tag).toBe("error")
    if (result._tag === "error") {
      expect(result.message).not.toContain(secret)
    }
  })
})

describe("runOpenNonDraftPullRequestCountCli", () => {
  test("writes the count on stdout with exit 0", async () => {
    const result = await runOpenNonDraftPullRequestCountCli(
      [encode("github"), encode("github.com"), encode("acme/widgets")],
      {
        env: { GITHUB_TOKEN: "test-token" },
        fetchImpl: async () =>
          jsonResponse({
            data: {
              repository: {
                pullRequests: {
                  nodes: [{ isDraft: false }, { isDraft: false }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }),
      },
    )
    expect(result).toEqual({ exitCode: 0, stdout: "2", stderr: "" })
  })

  test("exits 2 when the repository is unavailable", async () => {
    const result = await runOpenNonDraftPullRequestCountCli(
      [encode("github"), encode("github.com"), encode("acme/missing")],
      {
        env: { GITHUB_TOKEN: "test-token" },
        fetchImpl: async () => jsonResponse({ data: { repository: null } }),
      },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
  })

  test("exits 1 without a token and does not call GitHub", async () => {
    let called = false
    const result = await runOpenNonDraftPullRequestCountCli(
      [encode("github"), encode("github.com"), encode("acme/widgets")],
      {
        env: { GITHUB_TOKEN: "" },
        fetchImpl: async () => {
          called = true
          return jsonResponse({ data: { repository: null } })
        },
      },
    )
    expect(called).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("GITHUB_TOKEN")
  })

  test("exits 1 for a missing project path argument", async () => {
    const result = await runOpenNonDraftPullRequestCountCli(
      [encode("github"), encode("github.com")],
      { env: { GITHUB_TOKEN: "test-token" } },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Missing project path argument")
  })
})

describe("count-open-non-draft-pull-requests child process", () => {
  const children: Array<ReturnType<typeof spawn>> = []

  afterEach(() => {
    for (const child of children) {
      child.kill("SIGTERM")
    }
    children.length = 0
  })

  test("source entrypoint flushes stdio synchronously then forces process exit", async () => {
    // Hang-on-keep-alive: only setting exitCode left fetch sockets open.
    // False-zero cache: async write + process.exit can drop digits; writeSync
    // drains before exit.
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(binScript, "utf8")
    expect(source).toContain("writeSync(1, result.stdout)")
    expect(source).toContain("writeSync(2, result.stderr)")
    expect(source).toContain("process.exit(result.exitCode)")
    expect(source).not.toMatch(/process\.exitCode\s*=\s*result\.exitCode/)
  })

  test("fails safely without a token and never echoes a secret", async () => {
    const secret = "ghp_should_not_appear_in_stderr"
    const child = spawn(
      bunExecutable(),
      [
        "--conditions",
        "@ready-for-agent/source",
        binScript,
        encode("github"),
        encode("github.com"),
        encode("acme/widgets"),
      ],
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: "",
          // Ensure an accidental ambient secret is not required for this test.
          READY_FOR_AGENT_TEST_SECRET: secret,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    children.push(child)

    const stderrChunks: Buffer[] = []
    const stdoutChunks: Buffer[] = []
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code))
    })

    expect(exitCode).toBe(1)
    expect(exitCode).not.toBe(2)
    const stderr = Buffer.concat(stderrChunks).toString("utf8")
    const stdout = Buffer.concat(stdoutChunks).toString("utf8")
    expect(stderr.length).toBeGreaterThan(0)
    expect(stderr).not.toContain(secret)
    expect(stderr).not.toMatch(/ghp_[A-Za-z0-9]+/)
    expect(stdout).toBe("")
  })
})
