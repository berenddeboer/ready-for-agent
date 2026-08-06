import { PROMPT_ARGV_BYTE_LIMIT } from "@ready-for-agent/agent-backend"
import { buildRunArgs, shouldUsePromptStdin } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("buildRunArgs", () => {
  it("builds unsandboxed unattended JSONL exec args with model and effort", () => {
    expect(
      buildRunArgs({
        prompt: "implement the issue",
        model: "gpt-5.5",
        thinkingLevel: "medium",
      }),
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.5",
      "-c",
      "approval_policy=never",
      "-c",
      "model_reasoning_effort=medium",
      "--",
      "implement the issue",
    ])
  })

  it("omits model_reasoning_effort when thinkingLevel is null but keeps approval pin", () => {
    const args = buildRunArgs({
      prompt: "hi",
      model: "gpt-5.5",
      thinkingLevel: null,
    })
    expect(args).toContain("approval_policy=never")
    expect(args.some((a) => a.includes("model_reasoning_effort"))).toBe(false)
  })

  it("resumes by exact thread id and restates model/effort", () => {
    const args = buildRunArgs({
      prompt: "continue",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      resumeSessionId: "019fab2c-9466-7432-ad16-9de23f94f2db",
    })
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.6-sol",
      "-c",
      "approval_policy=never",
      "-c",
      "model_reasoning_effort=high",
      "resume",
      "019fab2c-9466-7432-ad16-9de23f94f2db",
      "--",
      "continue",
    ])
    expect(args).not.toContain("--last")
  })

  it("prefixes /review command into the prompt body", () => {
    const args = buildRunArgs({
      prompt: "Review uncommitted worktree changes.",
      model: "gpt-5.5",
      thinkingLevel: null,
      resumeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      command: "/review",
    })
    expect(args.at(-1)).toBe("/review\nReview uncommitted worktree changes.")
  })

  it("normalizes review command without a leading slash", () => {
    const args = buildRunArgs({
      prompt: "body",
      model: "gpt-5.5",
      thinkingLevel: null,
      command: "review",
    })
    expect(args.at(-1)).toBe("/review\nbody")
  })

  it("keeps a large single-line prompt off argv (ARG_MAX)", () => {
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    expect(prompt).not.toContain("\n")

    expect(shouldUsePromptStdin({ prompt })).toBe(true)
    expect(
      buildRunArgs({
        prompt,
        model: "gpt-5.5",
        thinkingLevel: "high",
      }),
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.5",
      "-c",
      "approval_policy=never",
      "-c",
      "model_reasoning_effort=high",
      "--",
      // `-` makes `codex exec` read the prompt from stdin.
      "-",
    ])
  })

  it("keeps single-line prompts at the argv byte limit on argv", () => {
    const prompt = "x".repeat(PROMPT_ARGV_BYTE_LIMIT)

    expect(shouldUsePromptStdin({ prompt })).toBe(false)
    const args = buildRunArgs({
      prompt,
      model: "gpt-5.5",
      thinkingLevel: null,
    })
    expect(args.at(-2)).toBe("--")
    expect(args.at(-1)).toBe(prompt)
  })

  it("routes large prompts to stdin on resume, keeping the thread id on argv", () => {
    const prompt = "x".repeat(PROMPT_ARGV_BYTE_LIMIT)
    // Body alone fits argv; the `/review\n` prefix pushes it over.
    expect(shouldUsePromptStdin({ prompt })).toBe(false)
    expect(shouldUsePromptStdin({ prompt, command: "/review" })).toBe(true)

    const args = buildRunArgs({
      prompt,
      model: "gpt-5.5",
      thinkingLevel: null,
      resumeSessionId: "019fab2c-9466-7432-ad16-9de23f94f2db",
      command: "/review",
    })
    expect(args.slice(-4)).toEqual([
      "resume",
      "019fab2c-9466-7432-ad16-9de23f94f2db",
      "--",
      "-",
    ])
  })

  it("does not treat a prompt of resume as the resume subcommand", () => {
    const start = buildRunArgs({
      prompt: "resume",
      model: "gpt-5.5",
      thinkingLevel: null,
    })
    expect(start).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--model",
      "gpt-5.5",
      "-c",
      "approval_policy=never",
      "--",
      "resume",
    ])
    // `--` precedes the prompt; no bare resume subcommand for a new turn.
    expect(start.indexOf("--")).toBeLessThan(start.lastIndexOf("resume"))
    expect(start.includes("resume") && start.indexOf("resume") === 1).toBe(
      false,
    )
  })
})
