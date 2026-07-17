import { sessionWorktreeLine } from "../src/session-worktree-line.ts"
import { describe, expect, test } from "bun:test"

describe("sessionWorktreeLine", () => {
  test("formats both session and worktree with spaces around slash", () => {
    expect(
      sessionWorktreeLine(
        "ses_090b4a729ffev80sNihn1xDyHB",
        "/home/berend/src/ready-for-agent/worktree1",
      ),
    ).toBe(
      "ses_090b4a729ffev80sNihn1xDyHB / /home/berend/src/ready-for-agent/worktree1",
    )
  })

  test("shows only session when path is missing", () => {
    expect(sessionWorktreeLine("ses_abc", null)).toBe("ses_abc")
    expect(sessionWorktreeLine("ses_abc", "")).toBe("ses_abc")
  })

  test("shows only worktree when session is missing", () => {
    expect(sessionWorktreeLine(null, "/tmp/wt")).toBe("/tmp/wt")
    expect(sessionWorktreeLine("", "/tmp/wt")).toBe("/tmp/wt")
  })

  test("returns null when both are empty", () => {
    expect(sessionWorktreeLine(null, null)).toBeNull()
    expect(sessionWorktreeLine("", "")).toBeNull()
    expect(sessionWorktreeLine(undefined, undefined)).toBeNull()
  })
})
