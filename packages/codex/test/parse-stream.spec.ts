import {
  codexAssistantText,
  createCodexStreamParseState,
  foldCodexStreamLine,
  isSuccessfulCodexTurn,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("parse-stream", () => {
  it("captures thread_id and concatenates agent_message text", () => {
    let state = createCodexStreamParseState()
    state = foldCodexStreamLine(
      state,
      '{"type":"thread.started","thread_id":"thread-1"}',
    )
    state = foldCodexStreamLine(state, '{"type":"turn.started"}')
    state = foldCodexStreamLine(
      state,
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"ignore"}}',
    )
    state = foldCodexStreamLine(
      state,
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hel"}}',
    )
    state = foldCodexStreamLine(
      state,
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"lo"}}',
    )
    state = foldCodexStreamLine(
      state,
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    )
    expect(state.threadId).toBe("thread-1")
    expect(codexAssistantText(state)).toBe("Hello")
    expect(isSuccessfulCodexTurn(state)).toBe(true)
  })

  it("marks non-json lines malformed", () => {
    let state = createCodexStreamParseState()
    state = foldCodexStreamLine(state, "not-json")
    expect(state.malformedLine).toBe(true)
  })

  it("marks thread.started without thread_id malformed", () => {
    let state = createCodexStreamParseState()
    state = foldCodexStreamLine(state, '{"type":"thread.started"}')
    expect(state.malformedLine).toBe(true)
  })

  it("tracks turn.failed", () => {
    let state = createCodexStreamParseState()
    state = foldCodexStreamLine(
      state,
      '{"type":"thread.started","thread_id":"t1"}',
    )
    state = foldCodexStreamLine(
      state,
      '{"type":"turn.failed","error":{"message":"model overloaded"}}',
    )
    expect(state.turnFailed).toBe(true)
    expect(state.turnFailedMessage).toBe("model overloaded")
    expect(isSuccessfulCodexTurn(state)).toBe(false)
  })

  it("ignores empty lines and unknown event types", () => {
    let state = createCodexStreamParseState()
    state = foldCodexStreamLine(state, "")
    state = foldCodexStreamLine(state, "   ")
    state = foldCodexStreamLine(
      state,
      '{"type":"thread.started","thread_id":"t1"}',
    )
    state = foldCodexStreamLine(
      state,
      '{"type":"item.started","item":{"type":"command_execution"}}',
    )
    state = foldCodexStreamLine(state, '{"type":"turn.completed"}')
    expect(state.malformedLine).toBe(false)
    expect(isSuccessfulCodexTurn(state)).toBe(true)
  })

  it("stops folding after malformed or turn.failed", () => {
    let state = createCodexStreamParseState()
    state = foldCodexStreamLine(state, "not-json")
    state = foldCodexStreamLine(
      state,
      '{"type":"thread.started","thread_id":"late"}',
    )
    expect(state.malformedLine).toBe(true)
    expect(state.threadId).toBeUndefined()

    state = createCodexStreamParseState()
    state = foldCodexStreamLine(
      state,
      '{"type":"thread.started","thread_id":"t1"}',
    )
    state = foldCodexStreamLine(
      state,
      '{"type":"turn.failed","error":{"message":"boom"}}',
    )
    state = foldCodexStreamLine(
      state,
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"after"}}',
    )
    state = foldCodexStreamLine(state, '{"type":"turn.completed"}')
    expect(state.turnFailed).toBe(true)
    expect(state.agentMessages).toEqual([])
    expect(state.turnCompleted).toBe(false)
  })
})
