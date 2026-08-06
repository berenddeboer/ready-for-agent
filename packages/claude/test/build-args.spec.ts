import { PROMPT_ARGV_BYTE_LIMIT } from "@ready-for-agent/agent-backend"
import { buildRunArgs, shouldUsePromptStdin } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("buildRunArgs", () => {
  it("builds unattended headless print-mode args with stream-json and permissions skip", () => {
    expect(
      buildRunArgs({
        prompt: "implement the issue",
        model: "sonnet",
        thinkingLevel: "medium",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--",
      "implement the issue",
    ])
  })

  it("isolates flag-like prompt bodies after end-of-options --", () => {
    const args = buildRunArgs({
      prompt: "--looks-like-a-flag",
      model: "sonnet",
      thinkingLevel: null,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    const endOptions = args.indexOf("--")
    expect(endOptions).toBeGreaterThan(0)
    expect(args[endOptions + 1]).toBe("--looks-like-a-flag")
    expect(args.at(-1)).toBe("--looks-like-a-flag")
  })

  it("omits --effort when thinkingLevel is null", () => {
    const args = buildRunArgs({
      prompt: "hi",
      model: "haiku",
      thinkingLevel: null,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    expect(args).not.toContain("--effort")
  })

  it("resumes an exact session id rather than most-recent continue", () => {
    const args = buildRunArgs({
      prompt: "continue",
      model: "opus",
      thinkingLevel: "low",
      resumeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    })
    expect(args).toContain("--resume")
    expect(args).toContain("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
    expect(args).not.toContain("--continue")
    expect(args).not.toContain("--fork-session")
    expect(args).not.toContain("--session-id")
    expect(args).not.toContain("-c")
  })

  it("never uses --bare on lifecycle turns", () => {
    const start = buildRunArgs({
      prompt: "work",
      model: "sonnet",
      thinkingLevel: null,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    const resume = buildRunArgs({
      prompt: "more",
      model: "sonnet",
      thinkingLevel: "high",
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
    })
    expect(start).not.toContain("--bare")
    expect(resume).not.toContain("--bare")
  })

  it("prefixes /review command into the single-prompt body", () => {
    const args = buildRunArgs({
      prompt: "Review uncommitted worktree changes.",
      model: "sonnet",
      thinkingLevel: null,
      resumeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      command: "/review",
    })
    expect(args.at(-1)).toBe("/review\nReview uncommitted worktree changes.")
    expect(args.at(-2)).toBe("--")
  })

  it("normalizes review command without a leading slash", () => {
    const args = buildRunArgs({
      prompt: "body",
      model: "sonnet",
      thinkingLevel: null,
      command: "review",
    })
    expect(args.at(-1)).toBe("/review\nbody")
  })

  it("keeps a large single-line prompt off argv (ARG_MAX)", () => {
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    expect(prompt).not.toContain("\n")

    const args = buildRunArgs({
      prompt,
      model: "sonnet",
      thinkingLevel: "high",
      sessionId: "11111111-1111-4111-8111-111111111111",
    })

    expect(shouldUsePromptStdin({ prompt })).toBe(true)
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
    ])
    expect(args).not.toContain("--")
  })

  it("keeps prompts at the argv byte limit on argv", () => {
    const prompt = "x".repeat(PROMPT_ARGV_BYTE_LIMIT)

    const args = buildRunArgs({
      prompt,
      model: "sonnet",
      thinkingLevel: null,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })

    expect(shouldUsePromptStdin({ prompt })).toBe(false)
    expect(args.at(-2)).toBe("--")
    expect(args.at(-1)).toBe(prompt)
  })

  it("routes large command prompts to stdin including the /review prefix", () => {
    const prompt = "x".repeat(PROMPT_ARGV_BYTE_LIMIT)
    // Body alone fits argv; the `/review\n` prefix pushes it over.
    expect(shouldUsePromptStdin({ prompt })).toBe(false)
    expect(shouldUsePromptStdin({ prompt, command: "/review" })).toBe(true)

    const args = buildRunArgs({
      prompt,
      model: "sonnet",
      thinkingLevel: null,
      resumeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      command: "/review",
    })
    expect(args).not.toContain("--")
    expect(args.at(-1)).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
  })

  it("passes free-text Bedrock inference profile ids through as --model (issue #806)", () => {
    const freeText =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile"
    const args = buildRunArgs({
      prompt: "implement",
      model: freeText,
      thinkingLevel: "high",
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    const modelFlag = args.indexOf("--model")
    expect(modelFlag).toBeGreaterThan(0)
    expect(args[modelFlag + 1]).toBe(freeText)
    expect(args).toContain("--effort")
    expect(args).toContain("high")
  })

  it("passes bare Bedrock profile ids through as --model without alias rewrite", () => {
    const freeText = "us.anthropic.claude-sonnet-4-6"
    const args = buildRunArgs({
      prompt: "work",
      model: freeText,
      thinkingLevel: null,
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    expect(args).toContain("--model")
    expect(args[args.indexOf("--model") + 1]).toBe(freeText)
    // Floating alias must not replace the free-text id.
    expect(args.filter((arg) => arg === "sonnet")).toEqual([])
  })
})
