import { PROMPT_ARGV_BYTE_LIMIT } from "@ready-for-agent/agent-backend"
import {
  buildCommandApiArgs,
  buildRunArgs,
  commandBodyExceedsArgvLimit,
  joinOpenCodeMessageArgs,
  openCodeModelReference,
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

const obsoleteFlags = ["--dir", "--variant", "--command"]

describe("buildRunArgs", () => {
  it("omits an explicit variant when thinkingLevel is null", () => {
    expect(openCodeModelReference("anthropic/claude-sonnet-4-5", null)).toBe(
      "anthropic/claude-sonnet-4-5",
    )
    expect(
      buildRunArgs({
        prompt: "fix the bug",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: null,
      }),
    ).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "-m",
      "anthropic/claude-sonnet-4-5",
      "--",
      "fix",
      "the",
      "bug",
    ])
  })

  it("builds start args with auto, json, model#variant, and tokenized prompt positionals", () => {
    const args = buildRunArgs({
      prompt: "fix the bug",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    })

    expect(args).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "-m",
      "anthropic/claude-sonnet-4-5#high",
      "--",
      "fix",
      "the",
      "bug",
    ])
    expect(obsoleteFlags.some((flag) => args.includes(flag))).toBe(false)
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
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    })

    expect(args).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "-m",
      "anthropic/claude-sonnet-4-5#high",
    ])
    expect(shouldUsePromptStdin({ prompt })).toBe(true)
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
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
      })

      expect(shouldUsePromptStdin({ prompt })).toBe(usesStdin)
      expect(messageTokensFromArgs(args)).toEqual(message)
      expect(args).not.toContain(prompt)
    }
  })

  it("keeps a large single-line prompt off argv (ARG_MAX)", () => {
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    expect(prompt).not.toContain("\n")

    const args = buildRunArgs({
      prompt,
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    })

    expect(shouldUsePromptStdin({ prompt })).toBe(true)
    expect(messageTokensFromArgs(args)).toEqual([])
    expect(args).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "-m",
      "anthropic/claude-sonnet-4-5#high",
    ])
  })

  it("keeps single-line prompts at the argv byte limit on argv", () => {
    const prompt = "x".repeat(PROMPT_ARGV_BYTE_LIMIT)

    const args = buildRunArgs({
      prompt,
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    })

    expect(shouldUsePromptStdin({ prompt })).toBe(false)
    expect(messageTokensFromArgs(args)).toEqual([prompt])
  })

  it("includes session for continue and protects the prompt with --", () => {
    expect(
      buildRunArgs({
        prompt: "continue the work",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "max",
        sessionId: "ses_abc",
      }),
    ).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "-m",
      "anthropic/claude-sonnet-4-5#max",
      "--session",
      "ses_abc",
      "--",
      "continue",
      "the",
      "work",
    ])
  })

  it("omits empty non-command prompt positionals", () => {
    expect(
      buildRunArgs({
        prompt: "   \n\t  ",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
      }),
    ).toEqual([
      "run",
      "--auto",
      "--format",
      "json",
      "-m",
      "anthropic/claude-sonnet-4-5#high",
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
      model: "xai/grok-code-fast-1",
      thinkingLevel: "high",
    })

    expect(shouldUsePromptStdin({ prompt })).toBe(true)
    expect(messageTokensFromArgs(args)).toEqual([])
    expect(args).not.toContain("--dir")
  })
})

describe("buildCommandApiArgs", () => {
  it("invokes /review through the V2 session command API with arguments preserved", () => {
    const prompt = [
      "Review uncommitted worktree changes.",
      "Do not edit files, commit, push, open pull requests, or apply findings in this turn.",
      "End your final response with exactly one machine-readable result line:",
      "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
      "or",
      "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
    ].join("\n")

    const invocation = buildCommandApiArgs({
      sessionId: "ses_review",
      command: "/review",
      prompt,
      directory: "/worktrees/repository",
    })

    expect(invocation.slice(0, 5)).toEqual([
      "api",
      "--header",
      `x-opencode-directory:${encodeURIComponent("/worktrees/repository")}`,
      "post",
      "/api/session/ses_review/command",
    ])
    expect(obsoleteFlags.some((flag) => invocation.includes(flag))).toBe(false)
    const body = JSON.parse(invocation.at(-1) ?? "") as {
      name: string
      text: string
      delivery: string
    }
    expect(body).toEqual({
      name: "review",
      text: prompt,
      delivery: "steer",
    })
    expect(body.text).toContain("READY_FOR_AGENT_RESULT: REVIEW_CLEAN")
    expect(body.text).toContain("READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS")
  })

  it("leaves the argv-size decision to the caller", () => {
    const prompt = "x".repeat(PROMPT_ARGV_BYTE_LIMIT + 1)
    const input = {
      sessionId: "ses_review",
      command: "/review",
      prompt,
      directory: "/worktrees/repository",
    }

    expect(commandBodyExceedsArgvLimit(input)).toBe(true)
    expect(buildCommandApiArgs(input)).toContain("--data")
  })
})
