import {
  normalizeCommandName,
  parseCommandTaskResultFromLine,
} from "../src/lib/parse-command-task-result.js"
import { describe, expect, it } from "bun:test"

describe("parseCommandTaskResultFromLine", () => {
  it("normalizes leading slashes on command names", () => {
    expect(normalizeCommandName("/review")).toBe("review")
    expect(normalizeCommandName("review")).toBe("review")
  })

  it("extracts the nested task_result for a matching command tool_use", () => {
    const childText = [
      "## Review Findings",
      "- Medium: example finding",
      "",
      "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
    ].join("\n")

    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_parent",
      part: {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {
            prompt: "Review uncommitted worktree changes.",
            description: "review changes",
            subagent_type: "build",
            command: "review",
          },
          output: `<task id="ses_child" state="completed">\n<task_result>\n${childText}\n</task_result>\n</task>`,
        },
      },
    })

    expect(parseCommandTaskResultFromLine(line, "/review")).toBe(childText)
    expect(parseCommandTaskResultFromLine(line, "review")).toBe(childText)
  })

  it("ignores non-matching commands, incomplete tasks, and plain text events", () => {
    expect(
      parseCommandTaskResultFromLine(
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { command: "other" },
              output:
                "<task_result>\nREADY_FOR_AGENT_RESULT: REVIEW_CLEAN\n</task_result>",
            },
          },
        }),
        "review",
      ),
    ).toBeUndefined()

    expect(
      parseCommandTaskResultFromLine(
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "task",
            state: {
              status: "running",
              input: { command: "review" },
            },
          },
        }),
        "review",
      ),
    ).toBeUndefined()

    expect(
      parseCommandTaskResultFromLine(
        JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
          },
        }),
        "review",
      ),
    ).toBeUndefined()
  })
})
