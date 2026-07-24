import {
  createGrokStreamParseState,
  foldGrokStreamLine,
  grokAssistantText,
  isSuccessfulGrokEnd,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("parse-stream", () => {
  it("concatenates text chunks and ignores thought", () => {
    let state = createGrokStreamParseState()
    state = foldGrokStreamLine(state, '{"type":"thought","data":"hmm"}')
    state = foldGrokStreamLine(state, '{"type":"text","data":"Hel"}')
    state = foldGrokStreamLine(state, '{"type":"text","data":"lo"}')
    state = foldGrokStreamLine(
      state,
      '{"type":"end","stopReason":"EndTurn","sessionId":"ses-1"}',
    )
    expect(grokAssistantText(state)).toBe("Hello")
    expect(isSuccessfulGrokEnd(state)).toBe(true)
    expect(state.endSessionId).toBe("ses-1")
  })

  it("marks non-json lines malformed", () => {
    let state = createGrokStreamParseState()
    state = foldGrokStreamLine(state, "not-json")
    expect(state.malformedLine).toBe(true)
  })

  it("tracks max turns and error events", () => {
    let state = createGrokStreamParseState()
    state = foldGrokStreamLine(state, '{"type":"max_turns_reached"}')
    expect(state.maxTurnsReached).toBe(true)
    expect(isSuccessfulGrokEnd(state)).toBe(false)

    state = createGrokStreamParseState()
    state = foldGrokStreamLine(
      state,
      '{"type":"error","message":"auth failed"}',
    )
    expect(state.errorMessage).toBe("auth failed")
  })
})
