import { buildRunArgs } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("buildRunArgs", () => {
  it("builds unattended headless args with auto-update disabled", () => {
    expect(
      buildRunArgs({
        prompt: "implement the issue",
        cwd: "/work",
        model: "grok-4.5",
        thinkingLevel: "medium",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual([
      "--no-auto-update",
      "--output-format",
      "streaming-json",
      "--yolo",
      "--cwd",
      "/work",
      "-m",
      "grok-4.5",
      "-p",
      "implement the issue",
      "--reasoning-effort",
      "medium",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
    ])
  })

  it("omits reasoning effort when thinkingLevel is null", () => {
    const args = buildRunArgs({
      prompt: "hi",
      cwd: "/work",
      model: "grok-4.5",
      thinkingLevel: null,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    expect(args).not.toContain("--reasoning-effort")
  })

  it("resumes an exact session id rather than most-recent continue", () => {
    const args = buildRunArgs({
      prompt: "continue",
      cwd: "/work",
      model: "grok-4.5",
      thinkingLevel: "low",
      resumeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    })
    expect(args).toContain("--resume")
    expect(args).toContain("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
    expect(args).not.toContain("--continue")
    expect(args).not.toContain("--session-id")
  })

  it("prefixes /review command into the single-prompt body", () => {
    const args = buildRunArgs({
      prompt: "Review uncommitted worktree changes.",
      cwd: "/work",
      model: "grok-4.5",
      thinkingLevel: null,
      resumeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      command: "/review",
    })
    const promptIndex = args.indexOf("-p")
    expect(args[promptIndex + 1]).toBe(
      "/review\nReview uncommitted worktree changes.",
    )
  })
})
