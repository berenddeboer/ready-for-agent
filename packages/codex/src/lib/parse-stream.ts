/**
 * Fold Codex `exec --json` JSONL events into Session ID + ordered assistant text.
 *
 * Session ID comes from the early `thread.started` event (`thread_id`). Final
 * assistant text is the ordered text of `item.completed` items whose type is
 * `agent_message`. Terminal success is `turn.completed`; failure is
 * `turn.failed` (mapped to an exit-style failure by the adapter).
 */

export type CodexStreamParseState = {
  threadId: string | undefined
  agentMessages: string[]
  turnCompleted: boolean
  turnFailed: boolean
  turnFailedMessage: string | undefined
  malformedLine: boolean
}

export const createCodexStreamParseState = (): CodexStreamParseState => ({
  threadId: undefined,
  agentMessages: [],
  turnCompleted: false,
  turnFailed: false,
  turnFailedMessage: undefined,
  malformedLine: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const errorMessageFrom = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    return value
  }
  if (isRecord(value)) {
    if (typeof value.message === "string" && value.message.length > 0) {
      return value.message
    }
    if (typeof value.error === "string" && value.error.length > 0) {
      return value.error
    }
  }
  return undefined
}

/**
 * Fold one JSONL line. Unknown event types are ignored (non-exhaustive stream).
 * Malformed JSON or missing `type` marks the stream malformed.
 * Once malformed or turn.failed, further lines leave state unchanged.
 */
export const foldCodexStreamLine = (
  state: CodexStreamParseState,
  line: string,
): CodexStreamParseState => {
  if (state.malformedLine || state.turnFailed) {
    return state
  }

  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return state
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ...state, malformedLine: true }
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { ...state, malformedLine: true }
  }

  switch (parsed.type) {
    case "thread.started": {
      const threadId =
        typeof parsed.thread_id === "string" ? parsed.thread_id : undefined
      if (threadId === undefined || threadId.length === 0) {
        return { ...state, malformedLine: true }
      }
      return { ...state, threadId }
    }
    case "item.completed": {
      if (!isRecord(parsed.item)) {
        return state
      }
      const item = parsed.item
      if (item.type !== "agent_message") {
        return state
      }
      if (typeof item.text !== "string") {
        return state
      }
      return {
        ...state,
        agentMessages: [...state.agentMessages, item.text],
      }
    }
    case "turn.completed":
      return { ...state, turnCompleted: true }
    case "turn.failed": {
      const message =
        errorMessageFrom(parsed.error) ??
        errorMessageFrom(parsed.message) ??
        "Codex turn.failed"
      return {
        ...state,
        turnFailed: true,
        turnFailedMessage: message,
      }
    }
    default:
      // Non-exhaustive event set (turn.started, item.started, tool events, …).
      return state
  }
}

/** Ordered final assistant text from agent_message item completions. */
export const codexAssistantText = (state: CodexStreamParseState): string =>
  state.agentMessages.join("")

export const isSuccessfulCodexTurn = (state: CodexStreamParseState): boolean =>
  state.turnCompleted &&
  !state.turnFailed &&
  state.malformedLine === false &&
  state.threadId !== undefined
