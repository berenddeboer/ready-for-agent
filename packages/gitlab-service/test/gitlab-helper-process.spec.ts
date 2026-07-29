import {
  INTERNAL_GITLAB_HELPER_ARG,
  formatGitLabHelperShellCommand,
  isInternalGitLabHelperMode,
  isStandaloneExecutable,
  resolveGitLabHelperChildSpawn,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

describe("internal GitLab helper mode", () => {
  test("detects the hidden internal argv token", () => {
    expect(isInternalGitLabHelperMode(["bun", "main.ts"])).toBe(false)
    expect(
      isInternalGitLabHelperMode([
        "ready-for-agent",
        INTERNAL_GITLAB_HELPER_ARG,
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
      resolveGitLabHelperChildSpawn({
        operation: "list-ready-issues",
        args: ["gitlab", "git.drupalcode.org", "project/oauth_client"],
        execPath: "/opt/ready-for-agent",
        argv: ["/opt/ready-for-agent", "start"],
      }),
    ).toEqual({
      command: "/opt/ready-for-agent",
      args: [
        INTERNAL_GITLAB_HELPER_ARG,
        "list-ready-issues",
        "gitlab",
        "git.drupalcode.org",
        "project/oauth_client",
      ],
    })
  })

  test("uses workspace bin scripts under a Bun source runtime", () => {
    const spawnPlan = resolveGitLabHelperChildSpawn({
      operation: "verify-project",
      args: ["gitlab", "git.drupalcode.org", "project/oauth_client"],
      execPath: "/usr/bin/bun",
      argv: ["/usr/bin/bun", "/repo/apps/harness/server.ts"],
    })
    expect(spawnPlan.command).toBe("/usr/bin/bun")
    expect(spawnPlan.args[0]).toBe("--conditions")
    expect(spawnPlan.args[1]).toBe("@ready-for-agent/source")
    expect(spawnPlan.args[2]).toMatch(/verify-project\.ts$/)
    expect(spawnPlan.args.slice(3)).toEqual([
      "gitlab",
      "git.drupalcode.org",
      "project/oauth_client",
    ])
    expect(formatGitLabHelperShellCommand(spawnPlan)).toContain(
      "verify-project.ts",
    )
    expect(formatGitLabHelperShellCommand(spawnPlan)).not.toContain(
      INTERNAL_GITLAB_HELPER_ARG,
    )
  })

  test("shell formatting quotes every argv token", () => {
    const command = formatGitLabHelperShellCommand({
      command: "/opt/ready-for-agent",
      args: [INTERNAL_GITLAB_HELPER_ARG, "list-ready-issues", "abc"],
    })
    expect(command).toBe(
      '"/opt/ready-for-agent" "--ready-for-agent-internal-gitlab-helper" "list-ready-issues" "abc"',
    )
  })
})
