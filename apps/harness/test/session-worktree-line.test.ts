import { sessionWorktreeParts } from "../src/session-worktree-line.ts"
import { describe, expect, test } from "bun:test"

describe("sessionWorktreeParts", () => {
  test("returns both session and worktree when present", () => {
    expect(
      sessionWorktreeParts(
        "ses_090b4a729ffev80sNihn1xDyHB",
        "/home/berend/src/ready-for-agent/worktree1",
      ),
    ).toEqual({
      sessionId: "ses_090b4a729ffev80sNihn1xDyHB",
      worktreePath: "/home/berend/src/ready-for-agent/worktree1",
    })
  })

  test("shows only session when path is missing", () => {
    expect(sessionWorktreeParts("ses_abc", null)).toEqual({
      sessionId: "ses_abc",
      worktreePath: null,
    })
    expect(sessionWorktreeParts("ses_abc", "")).toEqual({
      sessionId: "ses_abc",
      worktreePath: null,
    })
  })

  test("shows only worktree when session is missing", () => {
    expect(sessionWorktreeParts(null, "/tmp/wt")).toEqual({
      sessionId: null,
      worktreePath: "/tmp/wt",
    })
    expect(sessionWorktreeParts("", "/tmp/wt")).toEqual({
      sessionId: null,
      worktreePath: "/tmp/wt",
    })
  })

  test("returns null parts when both are empty", () => {
    expect(sessionWorktreeParts(null, null)).toEqual({
      sessionId: null,
      worktreePath: null,
    })
    expect(sessionWorktreeParts("", "")).toEqual({
      sessionId: null,
      worktreePath: null,
    })
    expect(sessionWorktreeParts(undefined, undefined)).toEqual({
      sessionId: null,
      worktreePath: null,
    })
  })
})
