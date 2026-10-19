import {
  AGENT_TURN_TAIL_ITEM_LIMIT,
  type AgentTurnTail,
  type AgentTurnTailSourceEvent,
  makeAgentTurnTail,
  missingAgentTurnTail,
  selectAgentTurnTail,
  unavailableAgentTurnTail,
} from "@ready-for-agent/agent-backend"
import {
  OPENCODE_V2_MALFORMED_DIAGNOSTIC,
  type OpencodeReadFailure,
  classifyOpencodeReadError,
  persistentFailure,
} from "./opencode-v2-compatibility.js"
import type { OpencodeSession } from "./session-store.js"

const OPENCODE_BACKEND = {
  id: "opencode",
  label: "OpenCode",
} as const

const TAIL_PAGE_LIMIT = 20
const TAIL_PAGE_CAP = 5
const STARTUP_CHILD_LIMIT = 5
const STARTUP_MESSAGE_LIMIT = 10

export type OpencodeV2Reader = {
  readonly getServerInfo: () => Promise<unknown>
  readonly getSession: (sessionId: string) => Promise<unknown>
  readonly listMessages: (input: {
    readonly sessionId: string
    readonly limit: number
    readonly order: "asc" | "desc"
    readonly cursor?: string
  }) => Promise<unknown>
  readonly listChildren: (input: {
    readonly parentId: string
    readonly limit: number
  }) => Promise<unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const toIso = (ms: number): string => new Date(ms).toISOString()

const unavailableSession = (
  id: string,
  diagnostic: string,
): OpencodeSession => ({
  id,
  availability: "unavailable",
  diagnostic,
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const missingSession = (id: string): OpencodeSession => ({
  id,
  availability: "missing",
  diagnostic: null,
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const sessionFromFailure = (
  id: string,
  failure: OpencodeReadFailure,
): OpencodeSession =>
  failure.kind === "missing"
    ? missingSession(id)
    : unavailableSession(id, failure.diagnostic)

/**
 * Session.Info rollup. Message token sums are intentionally ignored: the
 * running 2.0.32 server's session rollup is higher than the sum of currently
 * listed assistant messages.
 */
const sessionFromInfo = (
  id: string,
  raw: unknown,
): OpencodeSession | OpencodeReadFailure => {
  if (!isRecord(raw)) {
    return persistentFailure(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
  }
  const tokens = raw["tokens"]
  const time = raw["time"]
  if (!isRecord(tokens) || !isRecord(time)) {
    return persistentFailure(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
  }
  const cache = tokens["cache"]
  if (!isRecord(cache)) {
    return persistentFailure(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
  }
  const input = finiteNumber(tokens["input"])
  const output = finiteNumber(tokens["output"])
  const reasoning = finiteNumber(tokens["reasoning"])
  const cacheRead = finiteNumber(cache["read"])
  const cacheWrite = finiteNumber(cache["write"])
  const cost = finiteNumber(raw["cost"])
  const created = finiteNumber(time["created"])
  const updated = finiteNumber(time["updated"])
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cost === undefined ||
    created === undefined ||
    updated === undefined
  ) {
    return persistentFailure(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
  }
  const modelRaw = raw["model"]
  let model: OpencodeSession["model"] = null
  if (modelRaw !== undefined && modelRaw !== null) {
    if (!isRecord(modelRaw)) {
      return persistentFailure(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
    }
    const modelId = modelRaw["id"]
    const providerId = modelRaw["providerID"]
    if (typeof modelId !== "string" || typeof providerId !== "string") {
      return persistentFailure(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
    }
    if (modelId.length > 0 && providerId.length > 0) {
      const variant = modelRaw["variant"]
      model = {
        providerId,
        id: modelId,
        variant:
          typeof variant === "string" && variant.length > 0 ? variant : null,
      }
    }
  }
  return {
    id,
    availability: "available",
    diagnostic: null,
    model,
    tokens: {
      input: Math.trunc(input),
      output: Math.trunc(output),
      reasoning: Math.trunc(reasoning),
      cacheRead: Math.trunc(cacheRead),
      cacheWrite: Math.trunc(cacheWrite),
    },
    cost,
    createdAt: toIso(created),
    updatedAt: toIso(updated),
  }
}

const pageData = (
  raw: unknown,
): {
  readonly data: ReadonlyArray<unknown>
  readonly next: string | null
} | null => {
  if (!isRecord(raw) || !Array.isArray(raw["data"])) {
    return null
  }
  const cursor = raw["cursor"]
  const next =
    isRecord(cursor) && typeof cursor["next"] === "string"
      ? cursor["next"]
      : null
  return { data: raw["data"], next }
}

const messageTime = (message: Record<string, unknown>): number | null => {
  const time = message["time"]
  if (!isRecord(time)) {
    return null
  }
  return finiteNumber(time["created"]) ?? null
}

const toolStatus = (part: Record<string, unknown>): string => {
  const state = part["state"]
  if (!isRecord(state) || typeof state["status"] !== "string") {
    return "unknown"
  }
  const status = state["status"].trim()
  return status.length > 0 ? status : "unknown"
}

const eventsFromMessage = (
  message: unknown,
): ReadonlyArray<AgentTurnTailSourceEvent> => {
  if (!isRecord(message) || message["type"] !== "assistant") {
    return []
  }
  const created = messageTime(message)
  if (created === null || !Array.isArray(message["content"])) {
    return []
  }
  const at = toIso(created)
  const events: AgentTurnTailSourceEvent[] = []
  for (const part of message["content"]) {
    if (!isRecord(part)) {
      continue
    }
    if (part["type"] === "text" && typeof part["text"] === "string") {
      if (part["text"].length === 0) {
        continue
      }
      events.push({ kind: "assistant_text", text: part["text"], at })
    }
    if (part["type"] === "tool" && typeof part["name"] === "string") {
      const name = part["name"].trim()
      if (name.length === 0) {
        continue
      }
      const partTime = isRecord(part["time"])
        ? finiteNumber(part["time"]["created"])
        : undefined
      events.push({
        kind: "tool",
        name,
        status: toolStatus(part),
        at: partTime === undefined ? at : toIso(partTime),
      })
    }
  }
  return events
}

const isUserMessage = (message: unknown): boolean =>
  isRecord(message) && message["type"] === "user"

/**
 * Newest-first pages until the latest user message, or until the tail item
 * bound is filled. Tool input and output are never copied.
 */
const tailEventsFromPages = (
  pages: ReadonlyArray<unknown>,
): ReadonlyArray<AgentTurnTailSourceEvent> => {
  const groups: AgentTurnTailSourceEvent[][] = []
  let count = 0
  for (const page of pages) {
    const parsed = pageData(page)
    if (parsed === null) {
      break
    }
    let sawUser = false
    for (const message of parsed.data) {
      if (isUserMessage(message)) {
        sawUser = true
        break
      }
      const events = [...eventsFromMessage(message)]
      groups.push(events)
      count += events.length
      if (count >= AGENT_TURN_TAIL_ITEM_LIMIT) {
        return groups.reverse().flat().slice(-AGENT_TURN_TAIL_ITEM_LIMIT)
      }
    }
    if (sawUser) {
      break
    }
  }
  return groups.reverse().flat()
}

export const readSession = async (
  reader: OpencodeV2Reader,
  sessionId: string,
): Promise<OpencodeSession> => {
  try {
    const raw = await reader.getSession(sessionId)
    const mapped = sessionFromInfo(sessionId, raw)
    if ("kind" in mapped) {
      return sessionFromFailure(sessionId, mapped)
    }
    return mapped
  } catch (error) {
    return sessionFromFailure(sessionId, classifyOpencodeReadError(error))
  }
}

export const readTail = async (
  reader: OpencodeV2Reader,
  sessionId: string,
): Promise<AgentTurnTail> => {
  let session: OpencodeSession
  try {
    session = await readSession(reader, sessionId)
  } catch {
    return unavailableAgentTurnTail(OPENCODE_BACKEND)
  }
  if (session.availability === "missing") {
    return missingAgentTurnTail(OPENCODE_BACKEND)
  }
  if (session.availability !== "available") {
    return makeAgentTurnTail({
      availability: "unavailable",
      backend: OPENCODE_BACKEND,
      items: [],
      diagnostic: session.diagnostic,
    })
  }
  const pages: unknown[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < TAIL_PAGE_CAP; page += 1) {
      const raw = await reader.listMessages({
        sessionId,
        limit: TAIL_PAGE_LIMIT,
        order: "desc",
        ...(cursor === undefined ? {} : { cursor }),
      })
      pages.push(raw)
      const parsed = pageData(raw)
      if (parsed === null) {
        return makeAgentTurnTail({
          availability: "unavailable",
          backend: OPENCODE_BACKEND,
          items: [],
          diagnostic: OPENCODE_V2_MALFORMED_DIAGNOSTIC,
        })
      }
      const events = tailEventsFromPages(pages)
      const sawUser = parsed.data.some(isUserMessage)
      if (
        sawUser ||
        events.length >= AGENT_TURN_TAIL_ITEM_LIMIT ||
        parsed.next === null
      ) {
        return makeAgentTurnTail({
          availability: "available",
          backend: OPENCODE_BACKEND,
          items: selectAgentTurnTail(events),
        })
      }
      cursor = parsed.next
    }
  } catch (error) {
    const failure = classifyOpencodeReadError(error)
    if (failure.kind === "missing") {
      return missingAgentTurnTail(OPENCODE_BACKEND)
    }
    return makeAgentTurnTail({
      availability: "unavailable",
      backend: OPENCODE_BACKEND,
      items: [],
      diagnostic: failure.diagnostic,
    })
  }
  return makeAgentTurnTail({
    availability: "available",
    backend: OPENCODE_BACKEND,
    items: selectAgentTurnTail(tailEventsFromPages(pages)),
  })
}

const createdAtOrAfter = (
  record: Record<string, unknown>,
  startedAfterMs: number,
): boolean => {
  const time = record["time"]
  if (!isRecord(time)) {
    return false
  }
  const created = finiteNumber(time["created"])
  return created !== undefined && created >= startedAfterMs
}

const hasStartupActivity = (
  children: unknown,
  messages: unknown,
  startedAfterMs: number,
): boolean => {
  const childPage = pageData(children)
  if (childPage !== null) {
    for (const child of childPage.data) {
      if (isRecord(child) && createdAtOrAfter(child, startedAfterMs)) {
        return true
      }
    }
  }
  const messagePage = pageData(messages)
  if (messagePage === null) {
    return false
  }
  for (const message of messagePage.data) {
    if (!isRecord(message) || message["type"] !== "assistant") {
      continue
    }
    if (!Array.isArray(message["content"])) {
      continue
    }
    for (const part of message["content"]) {
      if (!isRecord(part)) {
        continue
      }
      const task =
        (part["type"] === "tool" && part["name"] === "task") ||
        part["type"] === "subtask"
      if (!task) {
        continue
      }
      const partTime = isRecord(part["time"])
        ? finiteNumber(part["time"]["created"])
        : undefined
      const created =
        partTime ??
        (isRecord(message["time"])
          ? finiteNumber(message["time"]["created"])
          : undefined)
      if (created !== undefined && created >= startedAfterMs) {
        return true
      }
    }
  }
  return false
}

export const probeStartupActivity = async (
  reader: OpencodeV2Reader,
  sessionId: string,
  startedAfterMs: number,
): Promise<boolean> => {
  if (sessionId.trim() === "") {
    return false
  }
  const children = await reader.listChildren({
    parentId: sessionId,
    limit: STARTUP_CHILD_LIMIT,
  })
  const messages = await reader.listMessages({
    sessionId,
    limit: STARTUP_MESSAGE_LIMIT,
    order: "desc",
  })
  return hasStartupActivity(children, messages, startedAfterMs)
}
