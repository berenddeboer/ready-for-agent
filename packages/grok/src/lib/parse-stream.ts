export type GrokStreamParseState = {
  textChunks: string[]
  endSessionId: string | undefined
  endStopReason: string | undefined
  endSeen: boolean
  errorMessage: string | undefined
  maxTurnsReached: boolean
  malformedLine: boolean
}

export const createGrokStreamParseState = (): GrokStreamParseState => ({
  textChunks: [],
  endSessionId: undefined,
  endStopReason: undefined,
  endSeen: false,
  errorMessage: undefined,
  maxTurnsReached: false,
  malformedLine: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Successful terminal stop reasons for a completed Agent Turn. */
const SUCCESS_STOP_REASONS = new Set([
  "endturn",
  "end_turn",
  "stop",
  "completed",
  "complete",
])

/**
 * Fold one streaming-json line. Text chunks are concatenated in arrival order;
 * thought/reasoning chunks are ignored. Exactly one terminal `end` is required.
 */
export const foldGrokStreamLine = (
  state: GrokStreamParseState,
  line: string,
): GrokStreamParseState => {
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
    case "text": {
      if (typeof parsed.data === "string") {
        return {
          ...state,
          textChunks: [...state.textChunks, parsed.data],
        }
      }
      return state
    }
    case "thought":
      return state
    case "error": {
      const message =
        typeof parsed.message === "string" ? parsed.message : "Grok error event"
      return { ...state, errorMessage: message }
    }
    case "max_turns_reached":
      return { ...state, maxTurnsReached: true }
    case "end": {
      const sessionId =
        typeof parsed.sessionId === "string" ? parsed.sessionId : undefined
      const stopReason =
        typeof parsed.stopReason === "string" ? parsed.stopReason : undefined
      return {
        ...state,
        endSeen: true,
        endSessionId: sessionId,
        endStopReason: stopReason,
      }
    }
    default:
      // Non-exhaustive event set (auto_compact_*, tool presentation, …).
      return state
  }
}

export const grokAssistantText = (state: GrokStreamParseState): string =>
  state.textChunks.join("")

export const isSuccessfulGrokEnd = (state: GrokStreamParseState): boolean => {
  if (!state.endSeen || state.errorMessage !== undefined) {
    return false
  }
  if (state.maxTurnsReached) {
    return false
  }
  if (state.endStopReason === undefined) {
    return true
  }
  return SUCCESS_STOP_REASONS.has(state.endStopReason.toLowerCase())
}
