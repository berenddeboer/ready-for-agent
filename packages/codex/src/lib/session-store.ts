import {
  type Dirent,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX,
  AGENT_TURN_TAIL_ITEM_LIMIT,
  type AgentTurnTail,
  type AgentTurnTailSourceEvent,
  makeAgentTurnTail,
  missingAgentTurnTail,
  selectAgentTurnTail,
  unavailableAgentTurnTail,
} from "@ready-for-agent/agent-backend"
import { Database } from "bun:sqlite"

export const CODEX_SESSION_PROVIDER_ID = "openai"

const CODEX_BACKEND = {
  id: AGENT_BACKEND_IDS.codex,
  label: "Codex Build",
} as const

export type CodexSessionModel = {
  readonly providerId: string
  readonly id: string
  readonly thinkingLevel: string | null
}

export type CodexSessionTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type CodexSessionAvailable = {
  readonly id: string
  readonly availability: "available"
  readonly model: CodexSessionModel | null
  readonly tokens: CodexSessionTokens
  readonly cost: null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export type CodexSessionUnavailable = {
  readonly id: string
  readonly availability: "missing" | "unavailable"
  readonly model: null
  readonly tokens: null
  readonly cost: null
  readonly createdAt: null
  readonly updatedAt: null
}

export type CodexSession = CodexSessionAvailable | CodexSessionUnavailable

export type CodexSessionStoreShape = {
  readonly getSession: (id: string) => Effect.Effect<CodexSession, never>
  readonly getTail: (id: string) => Effect.Effect<AgentTurnTail, never>
}

export class CodexSessionStore extends Context.Service<
  CodexSessionStore,
  CodexSessionStoreShape
>()("@ready-for-agent/codex/CodexSessionStore") {}

export type CodexHomeEnv = Partial<
  Record<"CODEX_HOME" | "HOME", string | undefined>
>

export type CodexSessionStoreOptions = {
  readonly env?: CodexHomeEnv
  readonly home?: string
  /** Absolute override for tests and embedding callers. */
  readonly codexHome?: string
}

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const trim = (value: string | undefined): string | undefined =>
  nonEmptyString(value) ?? undefined

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isMissingPathError = (error: unknown): boolean =>
  isRecord(error) && (error["code"] === "ENOENT" || error["code"] === "ENOTDIR")

const nonNegativeIntOrZero = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return 0
  }
  return value
}

const timestamp = (value: unknown): string | null => {
  const raw = nonEmptyString(value)
  if (raw === null) {
    return null
  }
  const milliseconds = Date.parse(raw)
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null
}

/** Resolve the same Codex home used by ambient Codex Build Agent Turns. */
export const resolveCodexHome = (
  options: CodexSessionStoreOptions = {},
): string => {
  const overridden = trim(options.codexHome)
  if (overridden !== undefined) {
    return overridden
  }
  const env = options.env ?? process.env
  const configured = trim(env.CODEX_HOME)
  if (configured !== undefined) {
    return configured
  }
  const home = options.home ?? trim(env.HOME) ?? homedir()
  return join(home, ".codex")
}

/** Reject path traversal before a Session ID can influence filesystem IO. */
export const isSafeCodexSessionIdSegment = (sessionId: string): boolean => {
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

export type CodexRolloutLookup =
  | {
      readonly kind: "found"
      readonly path: string
      readonly indexCreatedAt: string | null
      readonly indexUpdatedAt: string | null
    }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }

type DirectoryScan =
  | { readonly kind: "complete"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "unavailable" }

const scanRolloutDirectory = (input: {
  readonly directory: string
  readonly fileSuffix: string
}): DirectoryScan => {
  let entries: Dirent[]
  try {
    entries = readdirSync(input.directory, { withFileTypes: true })
  } catch {
    return { kind: "unavailable" }
  }

  const paths: string[] = []
  for (const entry of entries) {
    const path = join(input.directory, entry.name)
    if (entry.isDirectory()) {
      const nested = scanRolloutDirectory({
        directory: path,
        fileSuffix: input.fileSuffix,
      })
      if (nested.kind === "unavailable") {
        return nested
      }
      paths.push(...nested.paths)
      continue
    }
    if (
      entry.isFile() &&
      entry.name.startsWith("rollout-") &&
      entry.name.endsWith(input.fileSuffix)
    ) {
      paths.push(path)
    }
  }
  return { kind: "complete", paths }
}

type IndexedRollout = {
  readonly path: string
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

const timestampFromEpoch = (value: unknown): string | null => {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) {
    return null
  }
  // Codex's threads index currently stores Unix seconds. Accept milliseconds
  // as well so a future schema migration does not distort the timestamp.
  const milliseconds =
    Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric
  return new Date(milliseconds).toISOString()
}

const isPathWithin = (root: string, candidate: string): boolean => {
  const fromRoot = relative(resolve(root), resolve(candidate))
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  )
}

const resolvePathWithin = (root: string, candidate: string): string | null => {
  try {
    const resolvedRoot = realpathSync(root)
    const resolvedCandidate = realpathSync(candidate)
    return isPathWithin(resolvedRoot, resolvedCandidate)
      ? resolvedCandidate
      : null
  } catch {
    return null
  }
}

/**
 * Use Codex's optional threads index as a location fast path. Schema or IO
 * mismatches intentionally fall through to the sessions-tree scan.
 */
const findIndexedRollout = (input: {
  readonly codexHome: string
  readonly sessionsRoot: string
  readonly sessionId: string
}): IndexedRollout | null => {
  let stateFiles: string[]
  try {
    stateFiles = readdirSync(input.codexHome, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && /^state(?:_\d+)?\.sqlite$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, "en", { numeric: true }))
  } catch {
    return null
  }

  for (const stateFile of stateFiles) {
    let database: Database | undefined
    try {
      database = new Database(join(input.codexHome, stateFile), {
        readonly: true,
        create: false,
      })
      const row = database
        .query(
          `SELECT rollout_path, created_at, updated_at
           FROM threads
           WHERE id = ?
           LIMIT 1`,
        )
        .values(input.sessionId)[0]
      const rolloutPath = row?.[0]
      if (typeof rolloutPath !== "string" || rolloutPath.trim() === "") {
        continue
      }
      const path = isAbsolute(rolloutPath)
        ? rolloutPath
        : resolve(input.codexHome, rolloutPath)
      const resolvedPath = resolvePathWithin(input.sessionsRoot, path)
      if (resolvedPath === null) {
        continue
      }
      try {
        if (!statSync(resolvedPath).isFile()) {
          continue
        }
      } catch {
        continue
      }
      return {
        path: resolvedPath,
        createdAt: timestampFromEpoch(row?.[1]),
        updatedAt: timestampFromEpoch(row?.[2]),
      }
    } catch {
      // Older/mismatched/unreadable indexes are optional; scan rollouts.
    } finally {
      database?.close()
    }
  }
  return null
}

const sessionsRootLookup = (
  codexHome: string,
):
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" } => {
  const sessionsRoot = join(codexHome, "sessions")
  try {
    if (!statSync(sessionsRoot).isDirectory()) {
      return { kind: "unavailable" }
    }
  } catch (error) {
    return isMissingPathError(error)
      ? { kind: "missing" }
      : { kind: "unavailable" }
  }
  return { kind: "found", path: sessionsRoot }
}

/** Filename pattern used by the sessions-tree scan for a Session ID. */
const isScannedRolloutFileName = (
  fileName: string,
  sessionId: string,
): boolean =>
  fileName.startsWith("rollout-") && fileName.endsWith(`-${sessionId}.jsonl`)

const sameResolvedPath = (left: string, right: string): boolean => {
  if (left === right) {
    return true
  }
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

/**
 * Scan date-partitioned rollouts under the sessions tree by filename Session ID.
 * Symlinks are not followed, and duplicate suffix matches are unavailable
 * rather than being attributed arbitrarily.
 */
const findScannedRollout = (input: {
  readonly sessionsRoot: string
  readonly sessionId: string
  /** Skip an already-tried index path when falling back after a mismatch. */
  readonly excludePath?: string
}): CodexRolloutLookup => {
  const scan = scanRolloutDirectory({
    directory: input.sessionsRoot,
    fileSuffix: `-${input.sessionId}.jsonl`,
  })
  if (scan.kind === "unavailable") {
    return scan
  }
  const excludePath = input.excludePath
  const paths =
    excludePath === undefined
      ? scan.paths
      : scan.paths.filter((path) => !sameResolvedPath(path, excludePath))
  if (paths.length === 0) {
    return { kind: "missing" }
  }
  if (paths.length > 1) {
    return { kind: "unavailable" }
  }
  const path = paths[0]
  return path === undefined
    ? { kind: "missing" }
    : {
        kind: "found",
        path,
        indexCreatedAt: null,
        indexUpdatedAt: null,
      }
}

/**
 * Locate a unique Codex rollout: prefer a trustworthy threads index hit, then
 * fall back to scanning date-partitioned rollout filenames by Session ID.
 */
export const findCodexSessionRollout = (input: {
  readonly codexHome: string
  readonly sessionId: string
}): CodexRolloutLookup => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeCodexSessionIdSegment(id)) {
    return { kind: "missing" }
  }

  const sessionsRoot = sessionsRootLookup(input.codexHome)
  if (sessionsRoot.kind !== "found") {
    return sessionsRoot
  }

  const indexed = findIndexedRollout({
    codexHome: input.codexHome,
    sessionsRoot: sessionsRoot.path,
    sessionId: id,
  })
  if (indexed !== null) {
    return {
      kind: "found",
      path: indexed.path,
      indexCreatedAt: indexed.createdAt,
      indexUpdatedAt: indexed.updatedAt,
    }
  }

  return findScannedRollout({
    sessionsRoot: sessionsRoot.path,
    sessionId: id,
  })
}

type CodexRolloutFold = {
  readonly sessionId: string | null
  readonly model: CodexSessionModel | null
  readonly tokens: CodexSessionTokens
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

const emptyTokens = (): CodexSessionTokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

const earlierTimestamp = (
  left: string | null,
  right: string | null,
): string | null => {
  if (left === null) return right
  if (right === null) return left
  return Date.parse(left) <= Date.parse(right) ? left : right
}

const laterTimestamp = (
  left: string | null,
  right: string | null,
): string | null => {
  if (left === null) return right
  if (right === null) return left
  return Date.parse(left) >= Date.parse(right) ? left : right
}

const tokensFromTotalUsage = (value: unknown): CodexSessionTokens | null => {
  if (!isRecord(value)) {
    return null
  }
  return {
    input: nonNegativeIntOrZero(value["input_tokens"]),
    output: nonNegativeIntOrZero(value["output_tokens"]),
    reasoning: nonNegativeIntOrZero(value["reasoning_output_tokens"]),
    cacheRead: nonNegativeIntOrZero(value["cached_input_tokens"]),
    cacheWrite: nonNegativeIntOrZero(value["cache_write_input_tokens"]),
  }
}

/**
 * Fold a Codex rollout. JSONL can end in a partial live-written line, so
 * malformed lines are skipped; a valid `session_meta` establishes identity.
 */
export const foldCodexRollout = (raw: string): CodexRolloutFold => {
  let fold: CodexRolloutFold = {
    sessionId: null,
    model: null,
    tokens: emptyTokens(),
    createdAt: null,
    updatedAt: null,
  }

  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) {
        continue
      }
      const lineTimestamp = timestamp(parsed["timestamp"])
      fold = {
        ...fold,
        createdAt: earlierTimestamp(fold.createdAt, lineTimestamp),
        updatedAt: laterTimestamp(fold.updatedAt, lineTimestamp),
      }

      const payload = parsed["payload"]
      if (!isRecord(payload)) {
        continue
      }
      if (parsed["type"] === "session_meta") {
        const sessionId = nonEmptyString(payload["id"])
        const metaTimestamp = timestamp(payload["timestamp"])
        fold = {
          ...fold,
          sessionId: sessionId ?? fold.sessionId,
          createdAt: earlierTimestamp(fold.createdAt, metaTimestamp),
          updatedAt: laterTimestamp(fold.updatedAt, metaTimestamp),
        }
        continue
      }
      if (parsed["type"] === "turn_context") {
        const modelId = nonEmptyString(payload["model"])
        if (modelId !== null) {
          fold = {
            ...fold,
            model: {
              providerId: CODEX_SESSION_PROVIDER_ID,
              id: modelId,
              thinkingLevel:
                nonEmptyString(payload["effort"]) ??
                nonEmptyString(payload["reasoning_effort"]),
            },
          }
        }
        continue
      }
      if (parsed["type"] !== "event_msg" || payload["type"] !== "token_count") {
        continue
      }
      const info = payload["info"]
      if (!isRecord(info)) {
        continue
      }
      const tokens = tokensFromTotalUsage(info["total_token_usage"])
      if (tokens !== null) {
        fold = { ...fold, tokens }
      }
    } catch {
      // Rollouts are live-written; ignore corrupt or incomplete individual lines.
    }
  }
  return fold
}

const unavailable = (id: string): CodexSessionUnavailable => ({
  id,
  availability: "unavailable",
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const missing = (id: string): CodexSessionUnavailable => ({
  id,
  availability: "missing",
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

type ParsedRollout =
  | { readonly kind: "available"; readonly session: CodexSessionAvailable }
  | { readonly kind: "unreadable" }
  /** Readable but no trustworthy `session_meta` identity. */
  | { readonly kind: "corrupt" }
  /** Readable session_meta for a different Session ID. */
  | { readonly kind: "wrong_session" }

const parseRolloutAt = (input: {
  readonly sessionId: string
  readonly path: string
  readonly indexCreatedAt: string | null
  readonly indexUpdatedAt: string | null
}): ParsedRollout => {
  let raw: string
  try {
    raw = readFileSync(input.path, "utf8")
  } catch {
    return { kind: "unreadable" }
  }
  const fold = foldCodexRollout(raw)
  if (fold.sessionId === null) {
    return { kind: "corrupt" }
  }
  if (fold.sessionId !== input.sessionId) {
    return { kind: "wrong_session" }
  }
  return {
    kind: "available",
    session: {
      id: input.sessionId,
      availability: "available",
      model: fold.model,
      tokens: fold.tokens,
      cost: null,
      createdAt: fold.createdAt ?? input.indexCreatedAt,
      updatedAt: fold.updatedAt ?? input.indexUpdatedAt,
    },
  }
}

const sessionFromLookup = (input: {
  readonly sessionId: string
  readonly lookup: CodexRolloutLookup
}): CodexSession => {
  if (input.lookup.kind === "missing") {
    return missing(input.sessionId)
  }
  if (input.lookup.kind === "unavailable") {
    return unavailable(input.sessionId)
  }
  const parsed = parseRolloutAt({
    sessionId: input.sessionId,
    path: input.lookup.path,
    indexCreatedAt: input.lookup.indexCreatedAt,
    indexUpdatedAt: input.lookup.indexUpdatedAt,
  })
  if (parsed.kind === "available") {
    return parsed.session
  }
  // Scanned filename matched the Session ID but content is unusable.
  return unavailable(input.sessionId)
}

const readCodexSessionFromDisk = (input: {
  readonly codexHome: string
  readonly sessionId: string
}): CodexSession => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeCodexSessionIdSegment(id)) {
    return missing(id)
  }

  const sessionsRoot = sessionsRootLookup(input.codexHome)
  if (sessionsRoot.kind === "missing") {
    return missing(id)
  }
  if (sessionsRoot.kind === "unavailable") {
    return unavailable(id)
  }

  const indexed = findIndexedRollout({
    codexHome: input.codexHome,
    sessionsRoot: sessionsRoot.path,
    sessionId: id,
  })
  if (indexed !== null) {
    const parsed = parseRolloutAt({
      sessionId: id,
      path: indexed.path,
      indexCreatedAt: indexed.createdAt,
      indexUpdatedAt: indexed.updatedAt,
    })
    if (parsed.kind === "available") {
      return parsed.session
    }
    // Mismatched, stale, corrupt, or unreadable index paths fall through to a
    // sessions-tree scan so a trustworthy unique rollout can still win.
    const scanned = findScannedRollout({
      sessionsRoot: sessionsRoot.path,
      sessionId: id,
      excludePath: indexed.path,
    })
    if (scanned.kind === "found") {
      return sessionFromLookup({ sessionId: id, lookup: scanned })
    }
    if (scanned.kind === "unavailable") {
      return unavailable(id)
    }
    // No alternate rollout after excluding the index path.
    // Unreadable/corrupt index targets stay UNAVAILABLE.
    // wrong_session: MISSING only when the index pointed at a non-scan path for
    // a different Session (no matching Session for this id). If the index path
    // itself is a scan-pattern rollout for this id, match pure-scan behaviour
    // and report UNAVAILABLE for untrustworthy identity — not MISSING.
    if (parsed.kind === "wrong_session") {
      return isScannedRolloutFileName(basename(indexed.path), id)
        ? unavailable(id)
        : missing(id)
    }
    return unavailable(id)
  }

  return sessionFromLookup({
    sessionId: id,
    lookup: findScannedRollout({
      sessionsRoot: sessionsRoot.path,
      sessionId: id,
    }),
  })
}

const IDENTITY_PEEK_BYTES = 16_384
const TAIL_CHUNK_BYTES = 64 * 1024
const TAIL_PARSE_MAX_BYTES = 16 * 1024
/** Enough of a line to classify it and recover a 2k assistant-text cap. */
const TAIL_LINE_PREFIX_BYTES = AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX + 512

const availableTail = (
  events: ReadonlyArray<AgentTurnTailSourceEvent>,
): AgentTurnTail =>
  makeAgentTurnTail({
    availability: "available",
    backend: CODEX_BACKEND,
    items: selectAgentTurnTail(events),
  })

const extractQuotedFieldFrom = (
  raw: string,
  key: string,
  fromIndex: number,
): string | null => {
  const needle = `"${key}":"`
  const start = raw.indexOf(needle, fromIndex)
  if (start === -1) {
    return null
  }
  let index = start + needle.length
  let value = ""
  while (index < raw.length) {
    const char = raw[index]
    if (char === "\\") {
      const next = raw[index + 1]
      if (next === undefined) {
        break
      }
      if (next === "n") value += "\n"
      else if (next === "t") value += "\t"
      else if (next === '"') value += '"'
      else if (next === "\\") value += "\\"
      else value += next
      index += 2
      continue
    }
    if (char === '"') {
      return value
    }
    value += char
    index += 1
  }
  return value
}

const extractQuotedField = (raw: string, key: string): string | null =>
  extractQuotedFieldFrom(raw, key, 0)

/** Payload `type` sits after `"payload":{`, not in message/tool bodies. */
const extractPayloadType = (line: string): string | null => {
  const payloadIndex = line.indexOf('"payload"')
  if (payloadIndex === -1) {
    return null
  }
  return extractQuotedFieldFrom(line, "type", payloadIndex)
}

const isPayloadHeavyLine = (line: string): boolean => {
  const payloadType = extractPayloadType(line)
  return (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output" ||
    payloadType === "tool_search_output"
  )
}

const toolEvent = (input: {
  readonly name: string | null
  readonly status: string | null
  readonly at: string
}): AgentTurnTailSourceEvent | null => {
  if (input.name === null || input.name === "") {
    return null
  }
  return {
    kind: "tool",
    name: input.name,
    status:
      input.status === null || input.status === "" ? "unknown" : input.status,
    at: input.at,
  }
}

const largeLineToTailEvent = (
  line: string,
): AgentTurnTailSourceEvent | null => {
  const at = timestamp(extractQuotedField(line, "timestamp"))
  if (at === null) {
    return null
  }
  const outerType = extractQuotedField(line, "type")
  const payloadType = extractPayloadType(line)
  if (outerType === "event_msg") {
    if (payloadType === "user_message") {
      return { kind: "user", at }
    }
    if (payloadType === "agent_message") {
      const text = extractQuotedField(line, "message")
      if (text === null || text === "") {
        return null
      }
      return { kind: "assistant_text", text, at }
    }
    return null
  }
  if (outerType !== "response_item") {
    return null
  }
  if (payloadType === "message") {
    return extractQuotedField(line, "role") === "user"
      ? { kind: "user", at }
      : null
  }
  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    return toolEvent({
      name: extractQuotedField(line, "name"),
      status: extractQuotedField(line, "status"),
      at,
    })
  }
  if (payloadType === "web_search_call") {
    return toolEvent({
      name: "web_search",
      status: extractQuotedField(line, "status"),
      at,
    })
  }
  if (payloadType === "tool_search_call") {
    return toolEvent({
      name: "tool_search",
      status: extractQuotedField(line, "status"),
      at,
    })
  }
  return null
}

const parsedLineToTailEvent = (
  parsed: Readonly<Record<string, unknown>>,
): AgentTurnTailSourceEvent | null => {
  const at = timestamp(parsed["timestamp"])
  if (at === null) {
    return null
  }
  const payload = parsed["payload"]
  if (!isRecord(payload)) {
    return null
  }
  const outerType = parsed["type"]
  const payloadType = payload["type"]
  if (outerType === "event_msg") {
    if (payloadType === "user_message") {
      return { kind: "user", at }
    }
    if (payloadType === "agent_message") {
      const text =
        typeof payload["message"] === "string" ? payload["message"] : ""
      if (text === "") {
        return null
      }
      return { kind: "assistant_text", text, at }
    }
    return null
  }
  if (outerType !== "response_item") {
    return null
  }
  if (payloadType === "message") {
    return payload["role"] === "user" ? { kind: "user", at } : null
  }
  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    return toolEvent({
      name: nonEmptyString(payload["name"]),
      status: nonEmptyString(payload["status"]),
      at,
    })
  }
  if (payloadType === "web_search_call") {
    return toolEvent({
      name: "web_search",
      status: nonEmptyString(payload["status"]),
      at,
    })
  }
  if (payloadType === "tool_search_call") {
    return toolEvent({
      name: "tool_search",
      status: nonEmptyString(payload["status"]),
      at,
    })
  }
  return null
}

const lineToTailEvent = (line: string): AgentTurnTailSourceEvent | null => {
  const trimmed = line.trim()
  if (trimmed === "" || isPayloadHeavyLine(trimmed)) {
    return null
  }
  if (trimmed.length <= TAIL_PARSE_MAX_BYTES) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) {
        return parsedLineToTailEvent(parsed)
      }
    } catch {
      // Prefix of a longer line — classify from the type fields at the start.
    }
  }
  return largeLineToTailEvent(trimmed)
}

type PeekedRollout =
  | { readonly kind: "unreadable" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "identity"; readonly sessionId: string }

const peekCodexRolloutIdentity = (path: string): PeekedRollout => {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buf = Buffer.alloc(IDENTITY_PEEK_BYTES)
    const bytesRead = readSync(fd, buf, 0, IDENTITY_PEEK_BYTES, 0)
    const raw = buf.subarray(0, bytesRead).toString("utf8")
    for (const line of raw.split("\n")) {
      if (line.trim() === "") {
        continue
      }
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed) || parsed["type"] !== "session_meta") {
          continue
        }
        const payload = parsed["payload"]
        if (!isRecord(payload)) {
          continue
        }
        const sessionId = nonEmptyString(payload["id"])
        if (sessionId !== null) {
          return { kind: "identity", sessionId }
        }
      } catch {}
    }
    return { kind: "corrupt" }
  } catch {
    return { kind: "unreadable" }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/**
 * Read the latest Agent Turn from the end of a live-written rollout.
 * Stops at the last user event or 20 newer activity items. Only the first
 * 2k of each line is decoded so tool payloads are not loaded.
 */
const readTailEventsFromRollout = (
  path: string,
):
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "events"
      readonly events: ReadonlyArray<AgentTurnTailSourceEvent>
    } => {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    if (size === 0) {
      return { kind: "events", events: [] }
    }

    const activityNewestFirst: AgentTurnTailSourceEvent[] = []
    let foundUser = false
    let offset = size
    let leftoverHead: Buffer = Buffer.alloc(0)
    const chunk = Buffer.alloc(TAIL_CHUNK_BYTES)

    const consumeLine = (lineBuf: Buffer): void => {
      if (
        lineBuf.length === 0 ||
        foundUser ||
        activityNewestFirst.length >= AGENT_TURN_TAIL_ITEM_LIMIT
      ) {
        return
      }
      const prefix =
        lineBuf.length > TAIL_LINE_PREFIX_BYTES
          ? lineBuf.subarray(0, TAIL_LINE_PREFIX_BYTES)
          : lineBuf
      const event = lineToTailEvent(prefix.toString("utf8"))
      if (event === null) {
        return
      }
      if (event.kind === "user") {
        foundUser = true
        return
      }
      activityNewestFirst.push(event)
    }

    const capLeftover = (value: Buffer): Buffer =>
      value.length > TAIL_LINE_PREFIX_BYTES
        ? value.subarray(0, TAIL_LINE_PREFIX_BYTES)
        : value

    while (
      offset > 0 &&
      !foundUser &&
      activityNewestFirst.length < AGENT_TURN_TAIL_ITEM_LIMIT
    ) {
      const readSize = Math.min(TAIL_CHUNK_BYTES, offset)
      offset -= readSize
      const bytesRead = readSync(fd, chunk, 0, readSize, offset)
      const data = Buffer.concat([chunk.subarray(0, bytesRead), leftoverHead])
      const parts: Buffer[] = []
      let start = 0
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] === 0x0a) {
          parts.push(data.subarray(start, index))
          start = index + 1
        }
      }
      parts.push(data.subarray(start))
      leftoverHead = capLeftover(parts[0] ?? Buffer.alloc(0))
      for (let index = parts.length - 1; index >= 1; index -= 1) {
        const part = parts[index]
        if (part !== undefined) {
          consumeLine(part)
        }
      }
    }

    if (
      !foundUser &&
      leftoverHead.length > 0 &&
      activityNewestFirst.length < AGENT_TURN_TAIL_ITEM_LIMIT
    ) {
      consumeLine(leftoverHead)
    }

    return { kind: "events", events: activityNewestFirst.slice().reverse() }
  } catch {
    return { kind: "unreadable" }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

const tailFromFoundPath = (input: {
  readonly sessionId: string
  readonly path: string
}): AgentTurnTail => {
  const identity = peekCodexRolloutIdentity(input.path)
  if (identity.kind !== "identity" || identity.sessionId !== input.sessionId) {
    return unavailableAgentTurnTail(CODEX_BACKEND)
  }
  const events = readTailEventsFromRollout(input.path)
  if (events.kind === "unreadable") {
    return unavailableAgentTurnTail(CODEX_BACKEND)
  }
  return availableTail(events.events)
}

const tailFromLookup = (input: {
  readonly sessionId: string
  readonly lookup: CodexRolloutLookup
}): AgentTurnTail => {
  if (input.lookup.kind === "missing") {
    return missingAgentTurnTail(CODEX_BACKEND)
  }
  if (input.lookup.kind === "unavailable") {
    return unavailableAgentTurnTail(CODEX_BACKEND)
  }
  return tailFromFoundPath({
    sessionId: input.sessionId,
    path: input.lookup.path,
  })
}

const readCodexTailFromDisk = (input: {
  readonly codexHome: string
  readonly sessionId: string
}): AgentTurnTail => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeCodexSessionIdSegment(id)) {
    return missingAgentTurnTail(CODEX_BACKEND)
  }

  const sessionsRoot = sessionsRootLookup(input.codexHome)
  if (sessionsRoot.kind === "missing") {
    return missingAgentTurnTail(CODEX_BACKEND)
  }
  if (sessionsRoot.kind === "unavailable") {
    return unavailableAgentTurnTail(CODEX_BACKEND)
  }

  const indexed = findIndexedRollout({
    codexHome: input.codexHome,
    sessionsRoot: sessionsRoot.path,
    sessionId: id,
  })
  if (indexed !== null) {
    const identity = peekCodexRolloutIdentity(indexed.path)
    if (identity.kind === "identity" && identity.sessionId === id) {
      const events = readTailEventsFromRollout(indexed.path)
      if (events.kind === "unreadable") {
        return unavailableAgentTurnTail(CODEX_BACKEND)
      }
      return availableTail(events.events)
    }
    const scanned = findScannedRollout({
      sessionsRoot: sessionsRoot.path,
      sessionId: id,
      excludePath: indexed.path,
    })
    if (scanned.kind === "found") {
      return tailFromLookup({ sessionId: id, lookup: scanned })
    }
    if (scanned.kind === "unavailable") {
      return unavailableAgentTurnTail(CODEX_BACKEND)
    }
    if (identity.kind === "identity") {
      return isScannedRolloutFileName(basename(indexed.path), id)
        ? unavailableAgentTurnTail(CODEX_BACKEND)
        : missingAgentTurnTail(CODEX_BACKEND)
    }
    return unavailableAgentTurnTail(CODEX_BACKEND)
  }

  return tailFromLookup({
    sessionId: id,
    lookup: findScannedRollout({
      sessionsRoot: sessionsRoot.path,
      sessionId: id,
    }),
  })
}

export const makeCodexSessionStore = (
  shape: CodexSessionStoreShape,
): CodexSessionStoreShape => shape

export const CodexSessionStoreLive = (
  options: CodexSessionStoreOptions = {},
): Layer.Layer<CodexSessionStore> =>
  Layer.succeed(
    CodexSessionStore,
    makeCodexSessionStore({
      getSession: (id) =>
        Effect.sync(() =>
          readCodexSessionFromDisk({
            codexHome: resolveCodexHome(options),
            sessionId: id,
          }),
        ),
      getTail: (id) =>
        Effect.sync(() =>
          readCodexTailFromDisk({
            codexHome: resolveCodexHome(options),
            sessionId: id,
          }),
        ),
    }),
  )
