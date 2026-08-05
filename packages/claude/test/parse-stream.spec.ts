import {
  claudeAssistantText,
  createClaudeStreamParseState,
  foldClaudeStreamLine,
  isSuccessfulClaudeTurn,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("parse-stream", () => {
  it("prefers terminal result text and marks success", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(
      state,
      '{"type":"system","subtype":"init","session_id":"session-1","model":"sonnet"}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","session_id":"session-1","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"partial"}]}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","subtype":"success","session_id":"session-1","is_error":false,"result":"Done."}',
    )
    expect(state.sessionId).toBe("session-1")
    expect(claudeAssistantText(state)).toBe("Done.")
    expect(isSuccessfulClaudeTurn(state)).toBe(true)
  })

  it("falls back to ordered assistant text when result string is empty", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","session_id":"s1","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","session_id":"s1","message":{"role":"assistant","content":[{"type":"text","text":" second"}]}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","subtype":"success","session_id":"s1","is_error":false,"result":""}',
    )
    expect(claudeAssistantText(state)).toBe("first second")
    expect(isSuccessfulClaudeTurn(state)).toBe(true)
  })

  it("ignores subagent assistant text with parent_tool_use_id", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","parent_tool_use_id":"toolu_parent","session_id":"s1","message":{"role":"assistant","content":[{"type":"text","text":"subagent noise"}]}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","session_id":"s1","message":{"role":"assistant","content":[{"type":"text","text":"root"}]}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","session_id":"s1","is_error":false,"result":""}',
    )
    expect(claudeAssistantText(state)).toBe("root")
  })

  it("ignores tool_use content blocks", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","session_id":"s1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","session_id":"s1","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","session_id":"s1","is_error":false,"result":"ok"}',
    )
    expect(claudeAssistantText(state)).toBe("ok")
  })

  it("marks non-json lines malformed", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(state, "not-json")
    expect(state.malformedLine).toBe(true)
  })

  it("tracks result is_error as failure", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","subtype":"error","session_id":"s1","is_error":true,"result":"","error":"Permission denied"}',
    )
    expect(state.resultSeen).toBe(true)
    expect(state.isError).toBe(true)
    expect(state.errorMessage).toBe("Permission denied")
    expect(isSuccessfulClaudeTurn(state)).toBe(false)
  })

  it("ignores empty lines and unknown event types", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(state, "")
    state = foldClaudeStreamLine(state, "   ")
    state = foldClaudeStreamLine(
      state,
      '{"type":"stream_event","event":{"type":"message_start"}}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","session_id":"s1","is_error":false,"result":"ok"}',
    )
    expect(state.malformedLine).toBe(false)
    expect(isSuccessfulClaudeTurn(state)).toBe(true)
  })

  it("stops folding after malformed or result", () => {
    let state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(state, "not-json")
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","session_id":"late","is_error":false,"result":"x"}',
    )
    expect(state.malformedLine).toBe(true)
    expect(state.resultSeen).toBe(false)

    state = createClaudeStreamParseState()
    state = foldClaudeStreamLine(
      state,
      '{"type":"result","session_id":"s1","is_error":false,"result":"first"}',
    )
    state = foldClaudeStreamLine(
      state,
      '{"type":"assistant","session_id":"s1","message":{"role":"assistant","content":[{"type":"text","text":"after"}]}}',
    )
    expect(state.resultSeen).toBe(true)
    expect(claudeAssistantText(state)).toBe("first")
    expect(state.assistantTextChunks).toEqual([])
  })
})
