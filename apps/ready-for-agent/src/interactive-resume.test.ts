import { interactiveResumeCommand } from "./interactive-resume.ts"
import { describe, expect, test } from "bun:test"

const sessionId = "85312e9f-9c57-42ef-9757-b2512cee57cd"
const workingDirectory = "/tmp/rfa-jump-worktree"

describe("interactive resume command contract", () => {
  test("builds the permission-bypassing OpenCode continuation argv", () => {
    expect(
      interactiveResumeCommand({
        backendId: "opencode",
        sessionId,
        workingDirectory,
      }),
    ).toEqual({
      executableName: "opencode",
      arguments: [workingDirectory, "--session", sessionId, "--auto"],
    })
  })

  test("pins the Work Item Agent Model on OpenCode resume so Jump cannot fall back to the ambient default", () => {
    expect(
      interactiveResumeCommand({
        backendId: "opencode",
        sessionId,
        workingDirectory,
        agentModel: "amazon-bedrock/au.anthropic.claude-sonnet-5",
        thinkingLevel: "high",
      }),
    ).toEqual({
      executableName: "opencode",
      arguments: [
        workingDirectory,
        "--session",
        sessionId,
        "--auto",
        "-m",
        "amazon-bedrock/au.anthropic.claude-sonnet-5",
      ],
    })
  })

  test("builds the permission-bypassing Grok Build continuation argv", () => {
    expect(
      interactiveResumeCommand({
        backendId: "grok",
        sessionId,
        workingDirectory,
      }),
    ).toEqual({
      executableName: "grok",
      arguments: [
        "--cwd",
        workingDirectory,
        "--resume",
        sessionId,
        "--permission-mode",
        "bypassPermissions",
      ],
    })
  })

  test("pins the Work Item Agent Model and Thinking Level on Grok Build resume", () => {
    expect(
      interactiveResumeCommand({
        backendId: "grok",
        sessionId,
        workingDirectory,
        agentModel: "grok-4",
        thinkingLevel: "high",
      }),
    ).toEqual({
      executableName: "grok",
      arguments: [
        "--cwd",
        workingDirectory,
        "--resume",
        sessionId,
        "--permission-mode",
        "bypassPermissions",
        "-m",
        "grok-4",
        "--reasoning-effort",
        "high",
      ],
    })
  })

  test("builds the permission-bypassing Codex Build continuation argv", () => {
    expect(
      interactiveResumeCommand({
        backendId: "codex",
        sessionId,
        workingDirectory,
      }),
    ).toEqual({
      executableName: "codex",
      arguments: [
        "resume",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        workingDirectory,
        sessionId,
      ],
    })
  })

  test("pins the Work Item Agent Model and Thinking Level on Codex Build resume", () => {
    expect(
      interactiveResumeCommand({
        backendId: "codex",
        sessionId,
        workingDirectory,
        agentModel: "gpt-5.4",
        thinkingLevel: "xhigh",
      }),
    ).toEqual({
      executableName: "codex",
      arguments: [
        "resume",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        workingDirectory,
        "-m",
        "gpt-5.4",
        "-c",
        "model_reasoning_effort=xhigh",
        sessionId,
      ],
    })
  })

  test("builds the permission-bypassing Claude Code continuation argv", () => {
    expect(
      interactiveResumeCommand({
        backendId: "claude",
        sessionId,
        workingDirectory,
      }),
    ).toEqual({
      executableName: "claude",
      arguments: ["--resume", sessionId, "--dangerously-skip-permissions"],
    })
  })

  test("pins the Work Item Agent Model and Thinking Level on Claude Code resume", () => {
    expect(
      interactiveResumeCommand({
        backendId: "claude",
        sessionId,
        workingDirectory,
        agentModel: "opus",
        thinkingLevel: "high",
      }),
    ).toEqual({
      executableName: "claude",
      arguments: [
        "--resume",
        sessionId,
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--effort",
        "high",
      ],
    })
  })

  test("returns null for an unsupported Agent Backend", () => {
    expect(
      interactiveResumeCommand({
        backendId: "unknown-backend",
        sessionId,
        workingDirectory,
      }),
    ).toBeNull()
  })
})
