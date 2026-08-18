import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs"
import {
  AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX,
  AGENT_TURN_TAIL_ITEM_LIMIT,
  type AgentBackendDescriptor,
  type AgentTurnTail,
  type AgentTurnTailSourceEvent,
  makeAgentTurnTail,
  selectAgentTurnTail,
  unavailableAgentTurnTail,
} from "@ready-for-agent/agent-backend"

const CHUNK_SIZE = 64 * 1024
const LINE_PREFIX_BYTES = 8 * 1024
const TEXT_EXTRACT_LIMIT = AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX + 1

const TOOL_STATUS = new Set(["completed", "failed", "in_progress", "cancelled"])

type ParsedEvent =
  | { readonly kind: "ignore" }
  | {
      readonly kind: "user"
      readonly at: string
      readonly sessionId: string | null
    }
  | {
      readonly kind: "assistant_text"
      readonly text: string
      readonly at: string
      readonly sessionId: string | null
    }
  | {
      readonly kind: "tool"
      readonly toolCallId: string
      readonly name: string
      readonly status: string | null
      readonly at: string
      readonly sessionId: string | null
    }

type CollectedUser = {
  kind: "user"
  at: string
}

type CollectedAssistant = {
  kind: "assistant_text"
  text: string
  at: string
}

type CollectedTool = {
  kind: "tool"
  toolCallId: string
  name: string
  status: string
  at: string
}

type Collected = CollectedUser | CollectedAssistant | CollectedTool

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const unixOrMsToIso = (value: number): string | null => {
  if (!Number.isFinite(value)) {
    return null
  }
  const ms = value < 1_000_000_000_000 ? value * 1000 : value
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toISOString()
}

const timestampToIso = (value: unknown): string | null => {
  if (typeof value === "number") {
    return unixOrMsToIso(value)
  }
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  if (trimmed === "") {
    return null
  }
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber) && trimmed !== "") {
    const fromNumber = unixOrMsToIso(asNumber)
    if (fromNumber !== null) {
      return fromNumber
    }
  }
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return new Date(parsed).toISOString()
}

const unescapeJson = (
  source: string,
  index: number,
): { readonly char: string; readonly next: number } | null => {
  const marker = source[index]
  if (marker === undefined) {
    return null
  }
  switch (marker) {
    case '"':
    case "\\":
    case "/":
      return { char: marker, next: index + 1 }
    case "b":
      return { char: "\b", next: index + 1 }
    case "f":
      return { char: "\f", next: index + 1 }
    case "n":
      return { char: "\n", next: index + 1 }
    case "r":
      return { char: "\r", next: index + 1 }
    case "t":
      return { char: "\t", next: index + 1 }
    case "u": {
      const hex = source.slice(index + 1, index + 5)
      if (hex.length < 4) {
        return null
      }
      const code = Number.parseInt(hex, 16)
      if (!Number.isFinite(code)) {
        return null
      }
      return { char: String.fromCharCode(code), next: index + 5 }
    }
    default:
      return { char: marker, next: index + 1 }
  }
}

const extractJsonString = (
  source: string,
  key: string,
  fromIndex = 0,
  maxLength = Number.POSITIVE_INFINITY,
): string | null => {
  const needle = `"${key}"`
  let searchFrom = fromIndex
  while (searchFrom < source.length) {
    const keyAt = source.indexOf(needle, searchFrom)
    if (keyAt === -1) {
      return null
    }
    let cursor = keyAt + needle.length
    while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
      cursor += 1
    }
    if (source[cursor] !== ":") {
      searchFrom = keyAt + 1
      continue
    }
    cursor += 1
    while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
      cursor += 1
    }
    if (source[cursor] !== '"') {
      searchFrom = keyAt + 1
      continue
    }
    cursor += 1
    let out = ""
    while (cursor < source.length) {
      const ch = source[cursor]
      if (ch === '"') {
        return out
      }
      if (ch === "\\") {
        const escaped = unescapeJson(source, cursor + 1)
        if (escaped === null) {
          return out.length > 0 ? out : null
        }
        if (out.length < maxLength) {
          out += escaped.char
        }
        cursor = escaped.next
        if (out.length >= maxLength) {
          return out
        }
        continue
      }
      if (out.length < maxLength) {
        out += ch
      }
      cursor += 1
      if (out.length >= maxLength) {
        return out
      }
    }
    return out.length > 0 ? out : null
  }
  return null
}

const extractTimestampFromPrefix = (source: string): string | null => {
  const match = /"timestamp"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(source)
  if (match === null || match[1] === undefined) {
    return null
  }
  return timestampToIso(Number(match[1]))
}

const extractSessionIdFromPrefix = (source: string): string | null => {
  const value = extractJsonString(source, "sessionId")
  if (value === null || value.trim() === "") {
    return null
  }
  return value
}

const extractToolNameFromPrefix = (source: string): string => {
  const metaAt = source.indexOf('"x.ai/tool"')
  if (metaAt !== -1) {
    const metaName = extractJsonString(source, "name", metaAt)
    if (metaName !== null && metaName.trim() !== "") {
      return metaName.trim()
    }
  }
  const title = extractJsonString(source, "title")
  return title?.trim() ?? ""
}

const extractToolStatusFromPrefix = (source: string): string | null => {
  const status = extractJsonString(source, "status")
  if (status === null) {
    return null
  }
  const trimmed = status.trim()
  if (!TOOL_STATUS.has(trimmed)) {
    return null
  }
  return trimmed
}

const extractAssistantTextFromPrefix = (source: string): string => {
  const contentAt = source.indexOf('"content"')
  const searchFrom = contentAt === -1 ? 0 : contentAt
  return extractJsonString(source, "text", searchFrom, TEXT_EXTRACT_LIMIT) ?? ""
}

const toolNameFromUpdate = (update: Record<string, unknown>): string => {
  const meta = isRecord(update["_meta"]) ? update["_meta"] : null
  const xai =
    meta !== null && isRecord(meta["x.ai/tool"]) ? meta["x.ai/tool"] : null
  if (xai !== null && typeof xai["name"] === "string") {
    const name = xai["name"].trim()
    if (name !== "") {
      return name
    }
  }
  if (typeof update["title"] === "string") {
    return update["title"].trim()
  }
  return ""
}

const toolStatusFromUpdate = (
  update: Record<string, unknown>,
): string | null => {
  if (typeof update["status"] !== "string") {
    return null
  }
  const status = update["status"].trim()
  if (!TOOL_STATUS.has(status)) {
    return null
  }
  return status
}

const assistantTextFromUpdate = (update: Record<string, unknown>): string => {
  const content = update["content"]
  if (!isRecord(content)) {
    return ""
  }
  if (content["type"] !== "text" || typeof content["text"] !== "string") {
    return ""
  }
  return content["text"].slice(0, TEXT_EXTRACT_LIMIT)
}

const parseCompleteLine = (line: string): ParsedEvent | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const at = timestampToIso(parsed["timestamp"])
  if (at === null) {
    return null
  }
  const params = parsed["params"]
  if (!isRecord(params)) {
    return null
  }
  const sessionId =
    typeof params["sessionId"] === "string" ? params["sessionId"] : null
  const update = params["update"]
  if (!isRecord(update) || typeof update["sessionUpdate"] !== "string") {
    return null
  }
  return eventFromUpdate({
    sessionUpdate: update["sessionUpdate"],
    at,
    sessionId,
    update,
  })
}

const parsePrefix = (prefix: string): ParsedEvent | null => {
  const sessionUpdate = extractJsonString(prefix, "sessionUpdate")
  if (sessionUpdate === null) {
    return null
  }
  const at = extractTimestampFromPrefix(prefix)
  if (at === null) {
    return null
  }
  return eventFromUpdate({
    sessionUpdate,
    at,
    sessionId: extractSessionIdFromPrefix(prefix),
    prefix,
  })
}

const eventFromUpdate = (input: {
  readonly sessionUpdate: string
  readonly at: string
  readonly sessionId: string | null
  readonly update?: Record<string, unknown>
  readonly prefix?: string
}): ParsedEvent | null => {
  switch (input.sessionUpdate) {
    case "user_message_chunk":
      return { kind: "user", at: input.at, sessionId: input.sessionId }
    case "agent_message_chunk": {
      const text =
        input.update === undefined
          ? input.prefix === undefined
            ? ""
            : extractAssistantTextFromPrefix(input.prefix)
          : assistantTextFromUpdate(input.update)
      if (text === "") {
        return { kind: "ignore" }
      }
      return {
        kind: "assistant_text",
        text,
        at: input.at,
        sessionId: input.sessionId,
      }
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId =
        input.update === undefined
          ? extractJsonString(input.prefix ?? "", "toolCallId")
          : typeof input.update["toolCallId"] === "string"
            ? input.update["toolCallId"]
            : null
      if (toolCallId === null || toolCallId.trim() === "") {
        return { kind: "ignore" }
      }
      const name =
        input.update === undefined
          ? extractToolNameFromPrefix(input.prefix ?? "")
          : toolNameFromUpdate(input.update)
      const status =
        input.update === undefined
          ? extractToolStatusFromPrefix(input.prefix ?? "")
          : toolStatusFromUpdate(input.update)
      return {
        kind: "tool",
        toolCallId: toolCallId.trim(),
        name,
        status,
        at: input.at,
        sessionId: input.sessionId,
      }
    }
    default:
      return { kind: "ignore" }
  }
}

const parseLinePrefix = (
  prefix: string,
  complete: boolean,
): ParsedEvent | null => {
  const trimmed = prefix.endsWith("\r") ? prefix.slice(0, -1) : prefix
  if (trimmed.trim() === "") {
    return { kind: "ignore" }
  }
  if (complete && trimmed.length <= LINE_PREFIX_BYTES) {
    return parseCompleteLine(trimmed) ?? parsePrefix(trimmed)
  }
  return parsePrefix(trimmed)
}

const belongsToSession = (event: ParsedEvent, sessionId: string): boolean => {
  if (event.kind === "ignore") {
    return false
  }
  if (event.sessionId === null || event.sessionId === "") {
    return true
  }
  return event.sessionId === sessionId
}

const capAssistantText = (text: string): string =>
  text.length > TEXT_EXTRACT_LIMIT ? text.slice(0, TEXT_EXTRACT_LIMIT) : text

const collectEventsFromFd = (
  fd: number,
  fileSize: number,
  sessionId: string,
): ReadonlyArray<AgentTurnTailSourceEvent> => {
  const collected: Collected[] = []
  const tools = new Map<string, CollectedTool>()
  let activityCount = 0
  let pendingUnnamed = 0
  let stop = false

  const considerStop = (): void => {
    if (activityCount >= AGENT_TURN_TAIL_ITEM_LIMIT && pendingUnnamed === 0) {
      stop = true
    }
  }

  const onEvent = (event: ParsedEvent): boolean => {
    if (!belongsToSession(event, sessionId) || event.kind === "ignore") {
      return true
    }
    if (event.kind === "user") {
      collected.push({ kind: "user", at: event.at })
      stop = true
      return false
    }
    if (event.kind === "assistant_text") {
      const last = collected[collected.length - 1]
      if (last !== undefined && last.kind === "assistant_text") {
        last.text = capAssistantText(event.text + last.text)
      } else {
        collected.push({
          kind: "assistant_text",
          text: capAssistantText(event.text),
          at: event.at,
        })
        activityCount += 1
      }
      return true
    }
    const existing = tools.get(event.toolCallId)
    if (existing !== undefined) {
      if (existing.name === "" && event.name !== "") {
        existing.name = event.name
        pendingUnnamed = Math.max(0, pendingUnnamed - 1)
      }
      considerStop()
      return !stop
    }
    if (activityCount >= AGENT_TURN_TAIL_ITEM_LIMIT) {
      considerStop()
      return !stop
    }
    const item: CollectedTool = {
      kind: "tool",
      toolCallId: event.toolCallId,
      name: event.name,
      status: event.status ?? "in_progress",
      at: event.at,
    }
    collected.push(item)
    tools.set(event.toolCallId, item)
    activityCount += 1
    if (item.name === "") {
      pendingUnnamed += 1
    }
    considerStop()
    return !stop
  }

  scanLinePrefixesReverse(fd, fileSize, (prefix, complete) => {
    if (stop) {
      return false
    }
    const event = parseLinePrefix(prefix, complete)
    if (event === null) {
      return true
    }
    return onEvent(event)
  })

  const events: AgentTurnTailSourceEvent[] = []
  for (let index = collected.length - 1; index >= 0; index -= 1) {
    const item = collected[index]
    if (item === undefined) {
      continue
    }
    if (item.kind === "user") {
      events.push({ kind: "user", at: item.at })
      continue
    }
    if (item.kind === "assistant_text") {
      events.push({
        kind: "assistant_text",
        text: item.text,
        at: item.at,
      })
      continue
    }
    if (item.name === "") {
      continue
    }
    events.push({
      kind: "tool",
      name: item.name,
      status: item.status,
      at: item.at,
    })
  }
  return events
}

const scanLinePrefixesReverse = (
  fd: number,
  fileSize: number,
  onPrefix: (prefix: string, complete: boolean) => boolean,
): void => {
  const chunk = Buffer.alloc(CHUNK_SIZE)
  let searchEnd = fileSize
  let nextLineEnd = fileSize

  const emit = (lineStart: number, lineEnd: number): boolean => {
    if (lineStart >= lineEnd) {
      return true
    }
    const lineLength = lineEnd - lineStart
    const readLen = Math.min(LINE_PREFIX_BYTES, lineLength)
    const buf = Buffer.allocUnsafe(readLen)
    const bytes = readSync(fd, buf, 0, readLen, lineStart)
    if (bytes <= 0) {
      return true
    }
    return onPrefix(
      buf.subarray(0, bytes).toString("utf8"),
      readLen === lineLength,
    )
  }

  while (searchEnd > 0) {
    const readSize = Math.min(CHUNK_SIZE, searchEnd)
    const readAt = searchEnd - readSize
    const bytesRead = readSync(fd, chunk, 0, readSize, readAt)
    if (bytesRead <= 0) {
      break
    }
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) {
        continue
      }
      const newlineAt = readAt + index
      const lineStart = newlineAt + 1
      const lineEnd = nextLineEnd
      nextLineEnd = newlineAt
      if (!emit(lineStart, lineEnd)) {
        return
      }
    }
    searchEnd = readAt
  }

  if (nextLineEnd > 0) {
    emit(0, nextLineEnd)
  }
}

export const readGrokUpdatesJsonlTail = (input: {
  readonly updatesPath: string
  readonly sessionId: string
  readonly backend: AgentBackendDescriptor
}): AgentTurnTail => {
  let fd: number | undefined
  try {
    const info = statSync(input.updatesPath)
    if (!info.isFile()) {
      return unavailableAgentTurnTail(input.backend)
    }
    fd = openSync(input.updatesPath, "r")
    const fileSize = fstatSync(fd).size
    if (fileSize <= 0) {
      return makeAgentTurnTail({
        availability: "available",
        backend: input.backend,
        items: [],
      })
    }
    const events = collectEventsFromFd(fd, fileSize, input.sessionId)
    return makeAgentTurnTail({
      availability: "available",
      backend: input.backend,
      items: selectAgentTurnTail(events),
    })
  } catch {
    return unavailableAgentTurnTail(input.backend)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The tail read already finished or failed.
      }
    }
  }
}
