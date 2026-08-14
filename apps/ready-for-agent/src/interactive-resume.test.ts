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
