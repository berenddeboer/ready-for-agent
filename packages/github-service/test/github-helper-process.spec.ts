import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import {
  INTERNAL_GITHUB_HELPER_ARG,
  formatGitHubHelperShellCommand,
  isInternalGitHubHelperMode,
  isStandaloneExecutable,
  resolveGitHubHelperChildSpawn,
} from "../src/index.js"

const harnessServerEntry = fileURLToPath(
  new URL("../../../apps/harness/server.ts", import.meta.url),
)

/** Vitest may run under Node; GitHub helper source entry still requires Bun. */
const bunExecutable = () =>
  process.execPath.includes("bun") ? process.execPath : "bun"

const encode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url")

describe("internal GitHub helper mode", () => {
  test("detects the hidden internal argv token", () => {
    expect(isInternalGitHubHelperMode(["bun", "main.ts"])).toBe(false)
    expect(
      isInternalGitHubHelperMode([
        "ready-for-agent",
        INTERNAL_GITHUB_HELPER_ARG,
        "list-ready-issues",
      ]),
    ).toBe(true)
  })

  test("classifies compiled binaries vs source runtimes", () => {
    expect(
      isStandaloneExecutable("/usr/bin/bun", [
        "/usr/bin/bun",
        "/app/server.ts",
      ]),
    ).toBe(false)
    expect(
      isStandaloneExecutable("/opt/ready-for-agent", [
        "/opt/ready-for-agent",
        "start",
      ]),
    ).toBe(true)
  })

  test("spawns the same binary with the internal mode flag when standalone", () => {
    expect(
      resolveGitHubHelperChildSpawn({
        operation: "list-ready-issues",
        args: ["owner", "name"],
        execPath: "/opt/ready-for-agent",
        argv: ["/opt/ready-for-agent", "start"],
      }),
    ).toEqual({
      command: "/opt/ready-for-agent",
      args: [INTERNAL_GITHUB_HELPER_ARG, "list-ready-issues", "owner", "name"],
    })
  })

  test("uses workspace bin scripts under a Bun source runtime", () => {
    const spawnPlan = resolveGitHubHelperChildSpawn({
      operation: "merge-pull-request",
      args: ["o", "n", "h"],
      execPath: "/usr/bin/bun",
      argv: ["/usr/bin/bun", "/repo/apps/harness/server.ts"],
    })
    expect(spawnPlan.command).toBe("/usr/bin/bun")
    expect(spawnPlan.args[0]).toBe("--conditions")
    expect(spawnPlan.args[1]).toBe("@ready-for-agent/source")
    expect(spawnPlan.args[2]).toMatch(/merge-pull-request\.ts$/)
    expect(spawnPlan.args.slice(3)).toEqual(["o", "n", "h"])
    expect(formatGitHubHelperShellCommand(spawnPlan)).toContain(
      "merge-pull-request.ts",
    )
    expect(formatGitHubHelperShellCommand(spawnPlan)).not.toContain(
      INTERNAL_GITHUB_HELPER_ARG,
    )
  })

  test("shell formatting quotes every argv token", () => {
    const command = formatGitHubHelperShellCommand({
      command: "/opt/ready-for-agent",
      args: [INTERNAL_GITHUB_HELPER_ARG, "list-ready-issues", "abc"],
    })
    expect(command).toBe(
      '"/opt/ready-for-agent" "--ready-for-agent-internal-github-helper" "list-ready-issues" "abc"',
    )
  })
})

describe("GitHub helper process boundary", () => {
  const children: Array<ReturnType<typeof spawn>> = []

  afterEach(() => {
    for (const child of children) {
      child.kill("SIGTERM")
    }
    children.length = 0
  })

  test("list-ready-issues helper fails safely without a token (read path)", async () => {
    const child = spawn(
      bunExecutable(),
      [
        "--conditions",
        "@ready-for-agent/source",
        harnessServerEntry,
        INTERNAL_GITHUB_HELPER_ARG,
        "list-ready-issues",
        encode("acme"),
        encode("widgets"),
      ],
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    children.push(child)

    const stderrChunks: Buffer[] = []
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code))
    })

    expect(exitCode).not.toBe(0)
    expect(exitCode).not.toBe(2)
    const stderr = Buffer.concat(stderrChunks).toString("utf8")
    expect(stderr.length).toBeGreaterThan(0)
    expect(stderr).not.toMatch(/ghp_[A-Za-z0-9]+/)
  })

  test("merge-pull-request helper fails safely without a token (write path)", async () => {
    const child = spawn(
      bunExecutable(),
      [
        "--conditions",
        "@ready-for-agent/source",
        harnessServerEntry,
        INTERNAL_GITHUB_HELPER_ARG,
        "merge-pull-request",
        encode("acme"),
        encode("widgets"),
        encode("rfa/acme-widgets/1/wi-test"),
      ],
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    children.push(child)

    const stderrChunks: Buffer[] = []
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code))
    })

    expect(exitCode).not.toBe(0)
    expect(exitCode).not.toBe(2)
    const stderr = Buffer.concat(stderrChunks).toString("utf8")
    expect(stderr.length).toBeGreaterThan(0)
  })

  test("rejects unknown helper operations", async () => {
    const child = spawn(
      bunExecutable(),
      [
        "--conditions",
        "@ready-for-agent/source",
        harnessServerEntry,
        INTERNAL_GITHUB_HELPER_ARG,
        "not-a-real-operation",
      ],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    children.push(child)

    const stderrChunks: Buffer[] = []
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code))
    })

    expect(exitCode).toBe(1)
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain(
      "Unknown GitHub helper operation",
    )
  })
})
