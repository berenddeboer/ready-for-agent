import { parseCommandTranscript } from "../src/lib/parse-command-transcript.js"
import { describe, expect, it } from "bun:test"

const startedAfterMs = 1_000

describe("parseCommandTranscript", () => {
  it("returns a nested subagent result and ignores earlier session text", () => {
    const transcript = JSON.stringify({
      data: {
        messages: [
          {
            type: "assistant",
            time: { created: 100 },
            content: [
              { type: "text", text: "READY_FOR_AGENT_RESULT: REVIEW_FIXED" },
            ],
          },
          {
            type: "synthetic",
            time: { created: 2_000 },
            text: '<subagent sessionID="ses_child" state="completed" description="review">\nREADY_FOR_AGENT_RESULT: REVIEW_CLEAN\n</subagent>',
          },
        ],
      },
    })

    expect(
      parseCommandTranscript({
        transcript,
        command: "/review",
        startedAfterMs,
      }),
    ).toBe("READY_FOR_AGENT_RESULT: REVIEW_CLEAN")
  })

  it("prefers a matching task result over a later parent summary", () => {
    const transcript = JSON.stringify({
      messages: [
        {
          type: "assistant",
          time: { created: 2_000 },
          content: [
            {
              type: "tool",
              state: {
                status: "completed",
                input: { command: "review" },
                content: [
                  {
                    type: "text",
                    text: "<task_result>\nREADY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium\n</task_result>",
                  },
                ],
              },
            },
            {
              type: "text",
              text: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            },
          ],
        },
      ],
    })

    expect(
      parseCommandTranscript({
        transcript,
        command: "review",
        startedAfterMs,
      }),
    ).toBe("READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium")
  })
})
