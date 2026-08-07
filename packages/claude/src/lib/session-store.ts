import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { Context, Effect, Layer } from "effect"

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

export type ClaudeSessionStoreShape = {
  readonly getSession: (id: string) => Effect.Effect<ClaudeSession, never>
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
    }),
  )
