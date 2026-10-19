import { sessionOpenAction } from "../src/session-open-action.js"
import { describe, expect, it } from "bun:test"

describe("sessionOpenAction", () => {
  it("opens OpenCode when the server can be resolved", () => {
    expect(
      sessionOpenAction({
        canOpenInOpenCode: true,
        sessionId: "ses_example",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "open-in-opencode" })
  })

  it("keeps tail for other backends that can serve one", () => {
    expect(
      sessionOpenAction({
        canOpenInOpenCode: false,
        sessionId: "ses_example",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "tail" })
  })

  it("offers nothing when OpenCode has no server and tail is unsupported", () => {
    expect(
      sessionOpenAction({
        canOpenInOpenCode: false,
        sessionId: "ses_example",
        agentTurnTailSupported: false,
      }),
    ).toEqual({ kind: "none" })
  })

  it("does not offer tail without a session id", () => {
    expect(
      sessionOpenAction({
        canOpenInOpenCode: false,
        sessionId: "   ",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "none" })
  })
})
