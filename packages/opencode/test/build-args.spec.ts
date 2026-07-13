import { buildRunArgs } from "../src/lib/build-args.js"
import { describe, expect, it } from "bun:test"

describe("buildRunArgs", () => {
  it("builds start args with auto, json, model, and variant", () => {
    expect(
      buildRunArgs({
        prompt: "fix the bug",
        cwd: "/worktrees/repository",
        model: "anthropic/claude-sonnet-4-5",
        variant: "high",
      }),
    ).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "--dir",
      "/worktrees/repository",
      "-m",
      "anthropic/claude-sonnet-4-5",
      "--variant",
      "high",
      "fix the bug",
    ])
  })

  it("includes session for continue", () => {
    expect(
      buildRunArgs({
        prompt: "continue",
        cwd: "/worktrees/repository",
        model: "anthropic/claude-sonnet-4-5",
        variant: "max",
        sessionId: "ses_abc",
      }),
    ).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "--dir",
      "/worktrees/repository",
      "-m",
      "anthropic/claude-sonnet-4-5",
      "--variant",
      "max",
      "--session",
      "ses_abc",
      "continue",
    ])
  })
})
