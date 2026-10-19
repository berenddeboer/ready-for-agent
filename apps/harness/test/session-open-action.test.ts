import { sessionOpenAction } from "../src/session-open-action.js"
import { describe, expect, test } from "bun:test"

const EXAMPLE_URL =
  "http://127.0.0.1:49374/server/aHR0cDovLzEyNy4wLjAuMTo0OTM3NA/session/ses_ead6dfcf7ffejTs5Mqlo1UD64v"

describe("sessionOpenAction", () => {
  test("opens OpenCode instead of the tail viewer when a URL is available", () => {
    expect(
      sessionOpenAction({
        openInOpenCodeUrl: EXAMPLE_URL,
        sessionId: "ses_ead6dfcf7ffejTs5Mqlo1UD64v",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "open-in-opencode", url: EXAMPLE_URL })
  })

  test("keeps the tail for other backends", () => {
    expect(
      sessionOpenAction({
        openInOpenCodeUrl: null,
        sessionId: "019fab2c-9466-7432-ad16-9de23f94f2db",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "tail" })
  })

  test("falls back to the tail when an OpenCode server address is unavailable", () => {
    expect(
      sessionOpenAction({
        openInOpenCodeUrl: null,
        sessionId: "ses_owned",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "tail" })
    expect(
      sessionOpenAction({
        openInOpenCodeUrl: "   ",
        sessionId: "ses_owned",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "tail" })
  })

  test("does not offer a tail or OpenCode link without a session id and URL", () => {
    expect(
      sessionOpenAction({
        openInOpenCodeUrl: null,
        sessionId: null,
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "none" })
    expect(
      sessionOpenAction({
        openInOpenCodeUrl: null,
        sessionId: "ses_owned",
        agentTurnTailSupported: false,
      }),
    ).toEqual({ kind: "none" })
  })

  test("rejects a non-http URL instead of opening it", () => {
    expect(
      sessionOpenAction({
        openInOpenCodeUrl: "javascript:alert(1)",
        sessionId: "ses_owned",
        agentTurnTailSupported: true,
      }),
    ).toEqual({ kind: "tail" })
  })
})
