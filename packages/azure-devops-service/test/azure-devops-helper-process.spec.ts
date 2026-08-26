import {
  INTERNAL_AZURE_DEVOPS_HELPER_ARG,
  formatAzureDevOpsHelperShellCommand,
  isInternalAzureDevOpsHelperMode,
  isStandaloneExecutable,
  resolveAzureDevOpsHelperChildSpawn,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

describe("internal Azure DevOps helper mode", () => {
  test("detects the hidden internal argv token", () => {
    expect(isInternalAzureDevOpsHelperMode(["bun", "main.ts"])).toBe(false)
    expect(
      isInternalAzureDevOpsHelperMode([
        "ready-for-agent",
        INTERNAL_AZURE_DEVOPS_HELPER_ARG,
        "verify-project",
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
      resolveAzureDevOpsHelperChildSpawn({
        operation: "verify-project",
        args: ["azure-devops", "dev.azure.com", "acme/widgets"],
        execPath: "/opt/ready-for-agent",
        argv: ["/opt/ready-for-agent", "start"],
      }),
    ).toEqual({
      command: "/opt/ready-for-agent",
      args: [
        INTERNAL_AZURE_DEVOPS_HELPER_ARG,
        "verify-project",
        "azure-devops",
        "dev.azure.com",
        "acme/widgets",
      ],
    })
  })

  test("uses workspace bin scripts under a Bun source runtime", () => {
    const spawnPlan = resolveAzureDevOpsHelperChildSpawn({
      operation: "list-ready-issues",
      args: ["azure-devops", "dev.azure.com", "acme/widgets"],
      execPath: "/usr/bin/bun",
      argv: ["/usr/bin/bun", "/repo/apps/harness/server.ts"],
    })
    expect(spawnPlan.command).toBe("/usr/bin/bun")
    expect(spawnPlan.args[0]).toBe("--conditions")
    expect(spawnPlan.args[1]).toBe("@ready-for-agent/source")
    expect(spawnPlan.args[2]).toMatch(/list-ready-issues\.ts$/)
    expect(spawnPlan.args.slice(3)).toEqual([
      "azure-devops",
      "dev.azure.com",
      "acme/widgets",
    ])
    expect(formatAzureDevOpsHelperShellCommand(spawnPlan)).toContain(
      "list-ready-issues.ts",
    )
    expect(formatAzureDevOpsHelperShellCommand(spawnPlan)).not.toContain(
      INTERNAL_AZURE_DEVOPS_HELPER_ARG,
    )
  })

  test("shell formatting quotes every argv token", () => {
    const command = formatAzureDevOpsHelperShellCommand({
      command: "/opt/ready-for-agent",
      args: [INTERNAL_AZURE_DEVOPS_HELPER_ARG, "verify-project", "abc"],
    })
    expect(command).toBe(
      '"/opt/ready-for-agent" "--ready-for-agent-internal-azure-devops-helper" "verify-project" "abc"',
    )
  })
})
