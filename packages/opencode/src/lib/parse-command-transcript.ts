import { normalizeCommandName } from "./parse-command-task-result.js"

const taskResultFromOutput = (output: string): string | undefined => {
  const match = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i.exec(output)
  if (match === null) {
    return undefined
  }
  const text = match[1]?.trim() ?? ""
  return text.length > 0 ? text : undefined
}

const subagentText = (text: string): string | undefined => {
  const match = /<subagent\b[^>]*>\s*([\s\S]*?)\s*<\/subagent>/i.exec(text)
  if (match === null) {
    return undefined
  }
  const inner = match[1]?.trim() ?? ""
  return inner.length > 0 ? inner : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const createdMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const textFromContent = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return ""
  }
  return content
    .flatMap((part) => {
      if (
        !isRecord(part) ||
        part.type !== "text" ||
        typeof part.text !== "string"
      ) {
        return []
      }
      const text = part.text.trim()
      return text.length > 0 ? [text] : []
    })
    .join("\n")
}

const commandTaskResult = (
  message: Record<string, unknown>,
  commandName: string,
): string | undefined => {
  if (message.type !== "assistant" || !Array.isArray(message.content)) {
    return undefined
  }
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== "tool") {
      continue
    }
    const state = part.state
    if (!isRecord(state) || state.status !== "completed") {
      continue
    }
    const input = state.input
    if (
      !isRecord(input) ||
      typeof input.command !== "string" ||
      normalizeCommandName(input.command) !== commandName
    ) {
      continue
    }
    const output = textFromContent(state.content)
    const result = taskResultFromOutput(output)
    if (result !== undefined) {
      return result
    }
  }
  return undefined
}

const presentText = (text: string): string | undefined => {
  const nested = subagentText(text)
  if (nested !== undefined) {
    return nested
  }
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const messageText = (message: Record<string, unknown>): string | undefined => {
  if (message.type === "assistant") {
    const text = textFromContent(message.content)
    return text.length > 0 ? presentText(text) : undefined
  }
  if (
    (message.type === "synthetic" || message.type === "system") &&
    typeof message.text === "string"
  ) {
    return presentText(message.text)
  }
  return undefined
}

const messagesFromTranscript = (parsed: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(parsed)) {
    return parsed
  }
  if (!isRecord(parsed)) {
    return []
  }
  if (Array.isArray(parsed.messages)) {
    return parsed.messages
  }
  const data = parsed.data
  if (isRecord(data) && Array.isArray(data.messages)) {
    return data.messages
  }
  return []
}

export const parseCreatedSessionId = (stdout: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed
  if (
    !isRecord(data) ||
    typeof data.id !== "string" ||
    !data.id.startsWith("ses")
  ) {
    return undefined
  }
  return data.id
}

/**
 * The export lists messages in projection order (not by message ID or time).
 * `run` does not expose the submitted user message ID, so identify the exact
 * user message by the unique prompt we sent on stdin. Tool steps can precede
 * the final answer; OpenCode also continues steps cut short by an output
 * limit. Keep these earlier steps separate so even an empty final answer
 * cannot make an earlier line look final. A separate background reply can
 * follow the terminal step even without an idle boundary in between.
 */
export const parsePromptReply = (input: {
  readonly transcript: string
  readonly sessionId: string
  readonly submittedPrompt: string
}):
  | { readonly assistantText: string; readonly precedingAssistantText: string }
  | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.transcript)
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.info) ||
    parsed.info.id !== input.sessionId ||
    !Array.isArray(parsed.messages)
  ) {
    return undefined
  }
  const messages = parsed.messages.filter(isRecord)
  const isSubmission = (message: Record<string, unknown>) =>
    message.type === "user" && message.text === input.submittedPrompt
  const start = messages.findIndex(isSubmission)
  if (
    start < 0 ||
    messages.some((message, index) => index > start && isSubmission(message))
  ) {
    return undefined
  }
  const preceding: string[] = []
  for (const message of messages.slice(start + 1)) {
    if (message.type === "user" || message.type === "idle") break
    if (message.type !== "assistant") continue
    if (!isRecord(message.time) || typeof message.time.completed !== "number") {
      return undefined
    }
    if (!Array.isArray(message.content)) return undefined
    const text = textFromContent(message.content)
    // Some providers report "stop" even on steps with local tool calls.
    if (
      message.finish === "tool-calls" ||
      message.finish === "length" ||
      (message.finish === "stop" &&
        message.content.some(
          (part: unknown) =>
            isRecord(part) && part.type === "tool" && part.executed !== true,
        ))
    ) {
      preceding.push(text)
      continue
    }
    if (message.finish !== "stop") return undefined
    return { assistantText: text, precedingAssistantText: preceding.join("\n") }
  }
  return undefined
}

/**
 * Result of a V2 Agent Command from a session export.
 *
 * Only messages created after the command was submitted count, so a continued
 * Session does not replay an earlier Implement turn. A nested task or subagent
 * result wins over a later parent summary.
 */
export const parseCommandTranscript = (input: {
  readonly transcript: string
  readonly command: string
  readonly startedAfterMs: number
}): string | undefined => {
  const wanted = normalizeCommandName(input.command)
  if (wanted.length === 0) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input.transcript)
  } catch {
    return undefined
  }
  const messages = messagesFromTranscript(parsed)
  let fallback: string | undefined
  for (const message of messages) {
    if (!isRecord(message)) {
      continue
    }
    const time = isRecord(message.time)
      ? createdMs(message.time.created)
      : undefined
    if (time === undefined || time < input.startedAfterMs) {
      continue
    }
    const taskResult = commandTaskResult(message, wanted)
    if (taskResult !== undefined) {
      return taskResult
    }
    const text = messageText(message)
    if (text !== undefined) {
      fallback = text
    }
  }
  return fallback
}
