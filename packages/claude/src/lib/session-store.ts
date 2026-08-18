import {
  type Dirent,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  AGENT_TURN_TAIL_ITEM_LIMIT,
  type AgentTurnTail,
  type AgentTurnTailSourceEvent,
  makeAgentTurnTail,
  missingAgentTurnTail,
  selectAgentTurnTail,
  unavailableAgentTurnTail,
} from "@ready-for-agent/agent-backend"

export const CLAUDE_SESSION_PROVIDER_ID = "anthropic"
export const CLAUDE_BEDROCK_SESSION_PROVIDER_ID = "bedrock"

export type ClaudeSessionAvailability = "available" | "missing" | "unavailable"

export type ClaudeSessionModel = {
  readonly providerId: string
  readonly id: string
  readonly thinkingLevel: string | null
}

export type ClaudeSessionTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type ClaudeSessionAvailable = {
  readonly id: string
  readonly availability: "available"
  readonly model: ClaudeSessionModel | null
  readonly tokens: ClaudeSessionTokens
  readonly cost: null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export type ClaudeSessionUnavailable = {
  readonly id: string
  readonly availability: "missing" | "unavailable"
  readonly model: null
  readonly tokens: null
  readonly cost: null
  readonly createdAt: null
  readonly updatedAt: null
}

export type ClaudeSession = ClaudeSessionAvailable | ClaudeSessionUnavailable

const CLAUDE_BACKEND = {
  id: AGENT_BACKEND_IDS.claude,
  label: "Claude Code",
} as const

export type ClaudeSessionStoreShape = {
  readonly getSession: (id: string) => Effect.Effect<ClaudeSession, never>
  readonly getTail: (id: string) => Effect.Effect<AgentTurnTail, never>
}

export class ClaudeSessionStore extends Context.Service<
  ClaudeSessionStore,
  ClaudeSessionStoreShape
>()("@ready-for-agent/claude/ClaudeSessionStore") {}

export type ClaudeConfigDirEnv = Partial<
  Record<"CLAUDE_CONFIG_DIR" | "HOME", string | undefined>
>

export type ClaudeSessionStoreOptions = {
  readonly env?: ClaudeConfigDirEnv
  readonly home?: string
  /** Absolute override for tests and embedding callers. */
  readonly claudeConfigDir?: string
}

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const nonNegativeIntOrZero = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return 0
  }
  return Math.trunc(value)
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isMissingPathError = (error: unknown): boolean =>
  isRecord(error) && (error["code"] === "ENOENT" || error["code"] === "ENOTDIR")

const trim = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Resolve Claude Code's transcript root from the same ambient config as turns. */
export const resolveClaudeConfigDir = (
  options: ClaudeSessionStoreOptions = {},
): string => {
  const overridden = trim(options.claudeConfigDir)
  if (overridden !== undefined) {
    return overridden
  }
  const env = options.env ?? process.env
  const configured = trim(env.CLAUDE_CONFIG_DIR)
  if (configured !== undefined) {
    return configured
  }
  const home = options.home ?? trim(env.HOME) ?? homedir()
  return join(home, ".claude")
}

/**
 * Claude session ids are opaque single path segments. Reject traversal before
 * looking at the config directory so a requested id cannot influence IO.
 */
export const isSafeClaudeSessionIdSegment = (sessionId: string): boolean => {
  if (sessionId === "" || sessionId === "." || sessionId === "..") {
    return false
  }
  if (isAbsolute(sessionId)) {
    return false
  }
  if (
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    return false
  }
  return basename(sessionId) === sessionId
}

export type ClaudeSessionTranscriptLookup =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }

/**
 * Find a main Claude transcript without choosing arbitrarily between project
 * directories. Claude resumes by session id across projects, so duplicate ids
 * are an attribution failure rather than a first-match lookup.
 */
export const findClaudeSessionTranscript = (input: {
  readonly claudeConfigDir: string
  readonly sessionId: string
}): ClaudeSessionTranscriptLookup => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeClaudeSessionIdSegment(id)) {
    return { kind: "missing" }
  }

  const projectsRoot = join(input.claudeConfigDir, "projects")
  try {
    if (!statSync(projectsRoot).isDirectory()) {
      return { kind: "unavailable" }
    }
  } catch (error) {
    return isMissingPathError(error)
      ? { kind: "missing" }
      : { kind: "unavailable" }
  }

  let projectEntries: string[]
  try {
    projectEntries = readdirSync(projectsRoot)
  } catch {
    return { kind: "unavailable" }
  }

  let foundPath: string | null = null
  for (const projectEntry of projectEntries) {
    const candidate = join(projectsRoot, projectEntry, `${id}.jsonl`)
    try {
      if (!statSync(candidate).isFile()) {
        return { kind: "unavailable" }
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        continue
      }
      return { kind: "unavailable" }
    }
    if (foundPath !== null) {
      return { kind: "unavailable" }
    }
    foundPath = candidate
  }

  return foundPath === null
    ? { kind: "missing" }
    : { kind: "found", path: foundPath }
}

type ClaudeTranscriptFold = {
  readonly tokens: ClaudeSessionTokens
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly latestAssistant: {
    readonly model: ClaudeSessionModel | null
    readonly timestampMs: number | null
  } | null
}

const emptyTranscriptFold = (): ClaudeTranscriptFold => ({
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  createdAt: null,
  updatedAt: null,
  latestAssistant: null,
})

const timestampFromLine = (
  value: unknown,
): { readonly raw: string; readonly ms: number } | null => {
  const raw = nonEmptyString(value)
  if (raw === null) {
    return null
  }
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? { raw, ms } : null
}

const modelFromAssistantLine = (
  record: Readonly<Record<string, unknown>>,
): ClaudeSessionModel | null => {
  const message = record["message"]
  if (!isRecord(message)) {
    return null
  }
  const id = nonEmptyString(message["model"])
  if (id === null) {
    return null
  }
  return {
    providerId: id.startsWith("arn:")
      ? CLAUDE_BEDROCK_SESSION_PROVIDER_ID
      : CLAUDE_SESSION_PROVIDER_ID,
    id,
    thinkingLevel: nonEmptyString(record["effort"]),
  }
}

const usageFromAssistantLine = (
  record: Readonly<Record<string, unknown>>,
): ClaudeSessionTokens => {
  const message = record["message"]
  if (!isRecord(message)) {
    return emptyTranscriptFold().tokens
  }
  const usage = message["usage"]
  if (!isRecord(usage)) {
    return emptyTranscriptFold().tokens
  }
  return {
    input: nonNegativeIntOrZero(usage["input_tokens"]),
    output: nonNegativeIntOrZero(usage["output_tokens"]),
    reasoning: 0,
    cacheRead: nonNegativeIntOrZero(usage["cache_read_input_tokens"]),
    cacheWrite: nonNegativeIntOrZero(usage["cache_creation_input_tokens"]),
  }
}

/** Fold one JSONL transcript; malformed and incomplete trailing lines are ignored. */
export const foldClaudeTranscript = (
  raw: string,
  initial: ClaudeTranscriptFold = emptyTranscriptFold(),
): ClaudeTranscriptFold => {
  let fold = initial
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) {
        continue
      }

      const timestamp = timestampFromLine(parsed["timestamp"])
      const createdAt =
        timestamp === null
          ? fold.createdAt
          : fold.createdAt === null || timestamp.ms < Date.parse(fold.createdAt)
            ? timestamp.raw
            : fold.createdAt
      const updatedAt =
        timestamp === null
          ? fold.updatedAt
          : fold.updatedAt === null || timestamp.ms > Date.parse(fold.updatedAt)
            ? timestamp.raw
            : fold.updatedAt

      if (parsed["type"] !== "assistant") {
        fold = { ...fold, createdAt, updatedAt }
        continue
      }

      const usage = usageFromAssistantLine(parsed)
      const model = modelFromAssistantLine(parsed)
      fold = {
        tokens: {
          input: fold.tokens.input + usage.input,
          output: fold.tokens.output + usage.output,
          reasoning: 0,
          cacheRead: fold.tokens.cacheRead + usage.cacheRead,
          cacheWrite: fold.tokens.cacheWrite + usage.cacheWrite,
        },
        createdAt,
        updatedAt,
        // Transcript order, not timestamp order, defines the last-used model.
        latestAssistant: { model, timestampMs: timestamp?.ms ?? null },
      }
    } catch {
      // JSONL is live-written by Claude Code; a partial line is not a failure.
    }
  }
  return fold
}

const earlierTimestamp = (
  left: string | null,
  right: string | null,
): string | null => {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Date.parse(left) <= Date.parse(right) ? left : right
}

const laterTimestamp = (
  left: string | null,
  right: string | null,
): string | null => {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Date.parse(left) >= Date.parse(right) ? left : right
}

const laterAssistant = (
  left: ClaudeTranscriptFold["latestAssistant"],
  right: ClaudeTranscriptFold["latestAssistant"],
): ClaudeTranscriptFold["latestAssistant"] => {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  if (left.timestampMs === null) {
    return right
  }
  if (right.timestampMs === null) {
    return left
  }
  return right.timestampMs >= left.timestampMs ? right : left
}

/** Combine per-file folds; timestamps establish a session-wide model order. */
const combineClaudeTranscriptFolds = (
  left: ClaudeTranscriptFold,
  right: ClaudeTranscriptFold,
): ClaudeTranscriptFold => ({
  tokens: {
    input: left.tokens.input + right.tokens.input,
    output: left.tokens.output + right.tokens.output,
    reasoning: 0,
    cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
    cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
  },
  createdAt: earlierTimestamp(left.createdAt, right.createdAt),
  updatedAt: laterTimestamp(left.updatedAt, right.updatedAt),
  latestAssistant: laterAssistant(left.latestAssistant, right.latestAssistant),
})

const subagentTranscriptPaths = (subagentsRoot: string): string[] | null => {
  try {
    if (!statSync(subagentsRoot).isDirectory()) {
      return null
    }
  } catch (error) {
    return isMissingPathError(error) ? [] : null
  }

  const paths: string[] = []
  const visit = (directory: string): boolean => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.name.endsWith(".jsonl")) {
        if (!entry.isFile()) {
          return false
        }
        paths.push(path)
      } else if (entry.isDirectory()) {
        if (!visit(path)) {
          return false
        }
      }
    }
    return true
  }

  return visit(subagentsRoot) ? paths.sort() : null
}

const absent = (input: {
  readonly id: string
  readonly availability: Exclude<ClaudeSessionAvailability, "available">
}): ClaudeSessionUnavailable => ({
  id: input.id,
  availability: input.availability,
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const unavailable = (id: string): ClaudeSession =>
  absent({ id, availability: "unavailable" })

const missing = (id: string): ClaudeSession =>
  absent({ id, availability: "missing" })

const readClaudeSessionFromDisk = (input: {
  readonly claudeConfigDir: string
  readonly sessionId: string
}): ClaudeSession => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeClaudeSessionIdSegment(id)) {
    return missing(id)
  }

  const lookup = findClaudeSessionTranscript({
    claudeConfigDir: input.claudeConfigDir,
    sessionId: id,
  })
  if (lookup.kind === "missing") {
    return missing(id)
  }
  if (lookup.kind === "unavailable") {
    return unavailable(id)
  }

  const transcriptPaths = [lookup.path]
  const subagents = subagentTranscriptPaths(
    join(dirname(lookup.path), id, "subagents"),
  )
  if (subagents === null) {
    return unavailable(id)
  }
  transcriptPaths.push(...subagents)

  let fold = emptyTranscriptFold()
  for (const transcriptPath of transcriptPaths) {
    try {
      fold = combineClaudeTranscriptFolds(
        fold,
        foldClaudeTranscript(readFileSync(transcriptPath, "utf8")),
      )
    } catch {
      return unavailable(id)
    }
  }

  return {
    id,
    availability: "available",
    model: fold.latestAssistant?.model ?? null,
    tokens: fold.tokens,
    cost: null,
    createdAt: fold.createdAt,
    updatedAt: fold.updatedAt,
  }
}

const TAIL_READ_CHUNK_BYTES = 64 * 1024
const NEWLINE = 0x0a

type ClaudeTailLineEvent =
  | { readonly kind: "user"; readonly at: string }
  | {
      readonly kind: "assistant_text"
      readonly text: string
      readonly at: string
    }
  | {
      readonly kind: "tool_use"
      readonly id: string
      readonly name: string
      readonly at: string
    }
  | {
      readonly kind: "tool_result"
      readonly id: string
      readonly status: string
      readonly at: string
    }

const isChildSessionLine = (
  record: Readonly<Record<string, unknown>>,
): boolean =>
  record["isSidechain"] === true ||
  (record["parent_tool_use_id"] !== undefined &&
    record["parent_tool_use_id"] !== null)

const toolStatusFromResult = (isError: unknown): string =>
  isError === true ? "failed" : "completed"

const eventsFromUserContent = (
  content: unknown,
  at: string,
): ClaudeTailLineEvent[] => {
  if (typeof content === "string") {
    return [{ kind: "user", at }]
  }
  if (!Array.isArray(content)) {
    return [{ kind: "user", at }]
  }

  const events: ClaudeTailLineEvent[] = []
  let hasPrompt = false
  for (const block of content) {
    if (!isRecord(block)) {
      continue
    }
    if (block["type"] === "tool_result") {
      const id = nonEmptyString(block["tool_use_id"])
      if (id !== null) {
        events.push({
          kind: "tool_result",
          id,
          status: toolStatusFromResult(block["is_error"]),
          at,
        })
      }
      continue
    }
    if (block["type"] === "text") {
      hasPrompt = true
    }
  }
  if (hasPrompt || events.length === 0) {
    events.push({ kind: "user", at })
  }
  return events
}

const eventsFromAssistantContent = (
  content: unknown,
  at: string,
): ClaudeTailLineEvent[] => {
  if (typeof content === "string") {
    return content === "" ? [] : [{ kind: "assistant_text", text: content, at }]
  }
  if (!Array.isArray(content)) {
    return []
  }

  const events: ClaudeTailLineEvent[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      continue
    }
    if (block["type"] === "text") {
      const text = typeof block["text"] === "string" ? block["text"] : ""
      if (text !== "") {
        events.push({ kind: "assistant_text", text, at })
      }
      continue
    }
    if (block["type"] === "tool_use") {
      const id = nonEmptyString(block["id"])
      const name = nonEmptyString(block["name"])
      if (id !== null && name !== null) {
        events.push({ kind: "tool_use", id, name, at })
      }
    }
  }
  return events
}

/** Map one JSONL line to tail events. Unknown shapes and child lines are skipped. */
const eventsFromClaudeTranscriptLine = (
  line: string,
): ReadonlyArray<ClaudeTailLineEvent> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(parsed) || isChildSessionLine(parsed)) {
    return []
  }

  const timestamp = timestampFromLine(parsed["timestamp"])
  if (timestamp === null) {
    return []
  }
  const at = timestamp.raw
  const type = parsed["type"]

  if (type === "user") {
    const message = parsed["message"]
    return eventsFromUserContent(
      isRecord(message) ? message["content"] : undefined,
      at,
    )
  }

  if (type === "assistant") {
    const message = parsed["message"]
    return eventsFromAssistantContent(
      isRecord(message) ? message["content"] : undefined,
      at,
    )
  }

  if (type === "tool_use") {
    const id = nonEmptyString(parsed["id"])
    const name = nonEmptyString(parsed["name"])
    return id === null || name === null
      ? []
      : [{ kind: "tool_use", id, name, at }]
  }

  if (type === "tool_result") {
    const id = nonEmptyString(parsed["tool_use_id"])
    return id === null
      ? []
      : [
          {
            kind: "tool_result",
            id,
            status: toolStatusFromResult(parsed["is_error"]),
            at,
          },
        ]
  }

  return []
}

/**
 * Visit complete JSONL lines newest-first without decoding the rest of the
 * file once the visitor stops.
 */
const forEachJsonlLineFromEnd = (
  path: string,
  visit: (line: string) => boolean,
): void => {
  const fd = openSync(path, "r")
  try {
    let position = fstatSync(fd).size
    let leftover = Buffer.alloc(0)
    while (position > 0) {
      const toRead = Math.min(TAIL_READ_CHUNK_BYTES, position)
      position -= toRead
      const chunk = Buffer.allocUnsafe(toRead)
      readSync(fd, chunk, 0, toRead, position)
      const combined = Buffer.concat([chunk, leftover])
      let end = combined.length
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== NEWLINE) {
          continue
        }
        const line = combined.subarray(index + 1, end)
        end = index
        if (line.length === 0) {
          continue
        }
        if (!visit(line.toString("utf8"))) {
          return
        }
      }
      leftover = combined.subarray(0, end)
    }
    if (leftover.length > 0) {
      visit(leftover.toString("utf8"))
    }
  } finally {
    closeSync(fd)
  }
}

const readClaudeTailFromDisk = (input: {
  readonly claudeConfigDir: string
  readonly sessionId: string
}): AgentTurnTail => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeClaudeSessionIdSegment(id)) {
    return missingAgentTurnTail(CLAUDE_BACKEND)
  }

  const lookup = findClaudeSessionTranscript({
    claudeConfigDir: input.claudeConfigDir,
    sessionId: id,
  })
  if (lookup.kind === "missing") {
    return missingAgentTurnTail(CLAUDE_BACKEND)
  }
  if (lookup.kind === "unavailable") {
    return unavailableAgentTurnTail(CLAUDE_BACKEND)
  }

  try {
    const newestFirst: AgentTurnTailSourceEvent[] = []
    const pendingResults = new Map<string, string>()

    forEachJsonlLineFromEnd(lookup.path, (line) => {
      const lineEvents = eventsFromClaudeTranscriptLine(line)
      for (let index = lineEvents.length - 1; index >= 0; index -= 1) {
        const event = lineEvents[index]
        if (event === undefined) {
          continue
        }
        if (event.kind === "user") {
          return false
        }
        if (event.kind === "tool_result") {
          pendingResults.set(event.id, event.status)
          continue
        }
        if (event.kind === "tool_use") {
          newestFirst.push({
            kind: "tool",
            name: event.name,
            status: pendingResults.get(event.id) ?? "running",
            at: event.at,
          })
          pendingResults.delete(event.id)
        } else {
          newestFirst.push({
            kind: "assistant_text",
            text: event.text,
            at: event.at,
          })
        }
        if (newestFirst.length >= AGENT_TURN_TAIL_ITEM_LIMIT) {
          return false
        }
      }
      return true
    })

    return makeAgentTurnTail({
      availability: "available",
      backend: CLAUDE_BACKEND,
      items: selectAgentTurnTail(newestFirst.reverse()),
    })
  } catch {
    return unavailableAgentTurnTail(CLAUDE_BACKEND)
  }
}

export const makeClaudeSessionStore = (
  shape: ClaudeSessionStoreShape,
): ClaudeSessionStoreShape => shape

export const ClaudeSessionStoreLive = (
  options: ClaudeSessionStoreOptions = {},
): Layer.Layer<ClaudeSessionStore> =>
  Layer.succeed(
    ClaudeSessionStore,
    makeClaudeSessionStore({
      getSession: (id) =>
        Effect.sync(() =>
          readClaudeSessionFromDisk({
            claudeConfigDir: resolveClaudeConfigDir(options),
            sessionId: id,
          }),
        ),
      getTail: (id) =>
        Effect.sync(() =>
          readClaudeTailFromDisk({
            claudeConfigDir: resolveClaudeConfigDir(options),
            sessionId: id,
          }),
        ),
    }),
  )
