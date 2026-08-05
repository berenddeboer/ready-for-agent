/**
 * Fold Claude Code `-p --output-format stream-json --verbose` JSONL events into
 * ordered final assistant text and terminal success/failure.
 *
 * Session identity is preassigned by the adapter (`--session-id` / `--resume`);
 * the stream may still report `session_id` for mismatch detection. Final
 * assistant text prefers the terminal `result` string, falling back to ordered
 * assistant text content blocks. Terminal success is `type: "result"` with
 * `is_error` false (or success subtype); failure is `is_error` true.
 */

export type ClaudeStreamParseState = {
  sessionId: string | undefined
  assistantTextChunks: string[]
  resultText: string | undefined
  resultSeen: boolean
  isError: boolean
  errorMessage: string | undefined
  malformedLine: boolean
}

export const createClaudeStreamParseState = (): ClaudeStreamParseState => ({
  sessionId: undefined,
  assistantTextChunks: [],
  resultText: undefined,
  resultSeen: false,
  isError: false,
  errorMessage: undefined,
  malformedLine: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const textFromContentBlocks = (content: unknown): string[] => {
  if (!Array.isArray(content)) {
    return []
  }
  const chunks: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") {
      continue
    }
    if (typeof block.text === "string" && block.text.length > 0) {
      chunks.push(block.text)
    }
  }
  return chunks
}

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
 * Once malformed or result-seen, further lines leave state unchanged for
 * terminal fields (still ignore trailing noise after result).
 */
export const foldClaudeStreamLine = (
  state: ClaudeStreamParseState,
  line: string,
): ClaudeStreamParseState => {
  if (state.malformedLine || state.resultSeen) {
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

  const sessionId =
    typeof parsed.session_id === "string" && parsed.session_id.length > 0
      ? parsed.session_id
      : state.sessionId

  switch (parsed.type) {
    case "system": {
      // Init (and other system subtypes) may carry session_id early.
      return { ...state, sessionId }
    }
    case "assistant": {
      // Nested subagent assistant lines may carry parent_tool_use_id; keep
      // ordered text for the root turn only so empty-result fallback matches
      // main-agent output.
      if (
        parsed.parent_tool_use_id !== undefined &&
        parsed.parent_tool_use_id !== null
      ) {
        return { ...state, sessionId }
      }
      if (!isRecord(parsed.message)) {
        return { ...state, sessionId }
      }
      const chunks = textFromContentBlocks(parsed.message.content)
      if (chunks.length === 0) {
        return { ...state, sessionId }
      }
      return {
        ...state,
        sessionId,
        assistantTextChunks: [...state.assistantTextChunks, ...chunks],
      }
    }
    case "user":
    case "tool_use":
    case "tool_result":
      // Non-assistant content does not contribute final text.
      return { ...state, sessionId }
    case "result": {
      const isError =
        parsed.is_error === true ||
        (typeof parsed.subtype === "string" &&
          parsed.subtype.toLowerCase().includes("error"))
      const resultText =
        typeof parsed.result === "string" ? parsed.result : undefined
      const errorMessage =
        errorMessageFrom(parsed.error) ??
        errorMessageFrom(parsed.message) ??
        (isError ? "Claude Code turn failed" : undefined)
      return {
        ...state,
        sessionId,
        resultSeen: true,
        isError,
        resultText,
        errorMessage,
      }
    }
    default:
      // Non-exhaustive event set (stream_event, rate_limit, …).
      return { ...state, sessionId }
  }
}

/**
 * Ordered final assistant text: prefer the terminal `result` string when
 * present, otherwise joined assistant text content blocks.
 */
export const claudeAssistantText = (state: ClaudeStreamParseState): string => {
  if (state.resultText !== undefined && state.resultText.length > 0) {
    return state.resultText
  }
  return state.assistantTextChunks.join("")
}

export const isSuccessfulClaudeTurn = (
  state: ClaudeStreamParseState,
): boolean =>
  state.resultSeen && !state.isError && state.malformedLine === false
