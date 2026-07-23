import { buildRunArgs, joinOpenCodeMessageArgs } from "../src/lib/build-args.js"
import { describe, expect, it } from "bun:test"

const messageFromArgs = (args: ReadonlyArray<string>): string => {
  const separatorIndex = args.indexOf("--")
  if (separatorIndex !== -1) {
    return joinOpenCodeMessageArgs(args.slice(separatorIndex + 1))
  }
  const commandIndex = args.indexOf("--command")
  if (commandIndex !== -1) {
    return joinOpenCodeMessageArgs(args.slice(commandIndex + 2))
  }
  return joinOpenCodeMessageArgs(args.slice(-1))
}

describe("buildRunArgs", () => {
  it("builds start args with auto, json, model, and a single prompt positional", () => {
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

  it("preserves multi-line non-review prompts as one positional", () => {
    const prompt = [
      "Run git hook run --ignore-missing pre-commit",
      "",
      "```",
      "stderr excerpt",
      "```",
    ].join("\n")

    expect(
      buildRunArgs({
        prompt,
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
      prompt,
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

  it("invokes /review via --command with unquoted tokenized args after --", () => {
    const prompt = [
      "Review uncommitted worktree changes.",
      "Do not edit files, commit, push, open pull requests, or apply findings in this turn.",
      "End your final response with exactly one machine-readable result line:",
      "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
      "or",
      "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
    ].join("\n")

    const args = buildRunArgs({
      prompt,
      cwd: "/worktrees/repository",
      model: "anthropic/claude-sonnet-4-5",
      variant: "high",
      sessionId: "ses_review",
      command: "/review",
    })

    expect(args.slice(0, 15)).toEqual([
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
      "--session",
      "ses_review",
      "--command",
      "review",
      "--",
    ])
    expect(args).not.toContain("/review")
    expect(args.slice(15).every((token) => !token.includes(" "))).toBe(true)
    expect(args).toContain("uncommitted")
    expect(
      args.indexOf("--") < args.indexOf("--ignore-missing") ||
        !args.includes("--ignore-missing"),
    ).toBe(true)

    const withFlags = buildRunArgs({
      prompt: "use --ignore-missing safely",
      cwd: "/tmp",
      model: "m",
      variant: "v",
      command: "/review",
    })
    expect(
      withFlags.indexOf("--") < withFlags.indexOf("--ignore-missing"),
    ).toBe(true)

    const persisted = messageFromArgs(args)
    expect(persisted.startsWith('"')).toBe(false)
    expect(persisted.endsWith('"')).toBe(false)
    expect(persisted.startsWith("/review")).toBe(false)
    expect(persisted).toContain("Review uncommitted worktree changes.")
    expect(persisted).toContain(
      "Do not edit files, commit, push, open pull requests, or apply findings in this turn.",
    )
    expect(persisted).toContain("READY_FOR_AGENT_RESULT: REVIEW_CLEAN")
    expect(persisted).toContain("READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS")
  })

  it("omits empty prompt when only a command is set", () => {
    expect(
      buildRunArgs({
        prompt: "",
        cwd: "/worktrees/repository",
        model: "anthropic/claude-sonnet-4-5",
        variant: "high",
        command: "/review",
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
      "--command",
      "review",
    ])
  })
})
