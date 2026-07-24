import {
  buildRunArgs,
  joinOpenCodeMessageArgs,
  shouldUsePromptStdin,
} from "../src/lib/build-args.js"
import { describe, expect, it } from "bun:test"

const messageTokensFromArgs = (
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const separatorIndex = args.indexOf("--")
  return separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)
}

const messageFromArgs = (args: ReadonlyArray<string>): string =>
  joinOpenCodeMessageArgs(messageTokensFromArgs(args))

describe("buildRunArgs", () => {
  it("omits --variant when thinkingLevel is null", () => {
    expect(
      buildRunArgs({
        prompt: "fix the bug",
        cwd: "/worktrees/repository",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: null,
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
      "--",
      "fix",
      "the",
      "bug",
    ])
  })

  it("builds start args with auto, json, model, and tokenized prompt positionals", () => {
    const args = buildRunArgs({
      prompt: "fix the bug",
      cwd: "/worktrees/repository",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    })

    expect(args).toEqual([
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
      "--",
      "fix",
      "the",
      "bug",
    ])
    expect(messageTokensFromArgs(args)).toEqual(["fix", "the", "bug"])
    const persisted = messageFromArgs(args)
    expect(persisted).toBe("fix the bug")
    expect(persisted.startsWith('"')).toBe(false)
    expect(persisted.endsWith('"')).toBe(false)
  })

  it("uses stdin to preserve multi-line non-command prompts", () => {
    const prompt = [
      "Run git hook run --ignore-missing pre-commit",
      "",
      "```",
      "stderr excerpt",
      "```",
    ].join("\n")

    const args = buildRunArgs({
      prompt,
      cwd: "/worktrees/repository",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    })

    expect(args.slice(0, 10)).toEqual([
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
    ])
    expect(shouldUsePromptStdin(prompt)).toBe(true)
    expect(messageTokensFromArgs(args)).toEqual([])
    expect(args).not.toContain(prompt)
  })

  it("uses stdin only for newline-bearing prompts", () => {
    for (const [prompt, usesStdin, message] of [
      ["first\nsecond", true, []],
      ["first\tsecond", false, ["first", "second"]],
    ] as const) {
      const args = buildRunArgs({
        prompt,
        cwd: "/worktrees/repository",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
      })

      expect(shouldUsePromptStdin(prompt)).toBe(usesStdin)
      expect(messageTokensFromArgs(args)).toEqual(message)
      expect(args).not.toContain(prompt)
    }
  })

  it("includes session for continue and protects the prompt with --", () => {
    expect(
      buildRunArgs({
        prompt: "continue the work",
        cwd: "/worktrees/repository",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "max",
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
      "--",
      "continue",
      "the",
      "work",
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
      thinkingLevel: "high",
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
      thinkingLevel: "v",
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
        thinkingLevel: "high",
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

  it("omits empty non-command prompt positionals", () => {
    expect(
      buildRunArgs({
        prompt: "   \n\t  ",
        cwd: "/worktrees/repository",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
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
    ])
  })

  it("keeps implement-style multi-word prompts free of surrounding quotes", () => {
    const prompt = [
      "Implement GitHub issue berenddeboer/ready-for-agent#434.",
      "Inspect the current GitHub Issue and this Repository's agent/project instructions.",
      "Make the implementation in this worktree and run appropriate verification.",
      "Do not merely propose a plan; complete the implementation work for that exact issue.",
    ].join("\n")

    const args = buildRunArgs({
      prompt,
      cwd: "/worktrees/issue-434",
      model: "xai/grok-code-fast-1",
      thinkingLevel: "high",
    })

    const messageTokens = messageTokensFromArgs(args)
    expect(shouldUsePromptStdin(prompt)).toBe(true)
    expect(messageTokens).toEqual([])
  })
})
