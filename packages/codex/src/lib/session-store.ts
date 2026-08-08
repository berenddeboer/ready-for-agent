import {
  type Dirent,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Database } from "bun:sqlite"

export const CODEX_SESSION_PROVIDER_ID = "openai"

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

/**
 * Locate a unique date-partitioned Codex rollout by its filename Session ID.
 * Symlinks are not followed, and duplicate suffix matches are unavailable
 * rather than being attributed arbitrarily.
 */
export const findCodexSessionRollout = (input: {
  readonly codexHome: string
  readonly sessionId: string
}): CodexRolloutLookup => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeCodexSessionIdSegment(id)) {
    return { kind: "missing" }
  }

  const sessionsRoot = join(input.codexHome, "sessions")
  try {
    if (!statSync(sessionsRoot).isDirectory()) {
      return { kind: "unavailable" }
    }
  } catch (error) {
    return isMissingPathError(error)
      ? { kind: "missing" }
      : { kind: "unavailable" }
  }

  const indexed = findIndexedRollout({
    codexHome: input.codexHome,
    sessionsRoot,
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

  const scan = scanRolloutDirectory({
    directory: sessionsRoot,
    fileSuffix: `-${id}.jsonl`,
  })
  if (scan.kind === "unavailable") {
    return scan
  }
  if (scan.paths.length === 0) {
    return { kind: "missing" }
  }
  if (scan.paths.length > 1) {
    return { kind: "unavailable" }
  }
  const path = scan.paths[0]
  return path === undefined
    ? { kind: "missing" }
    : {
        kind: "found",
        path,
        indexCreatedAt: null,
        indexUpdatedAt: null,
      }
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

const readCodexSessionFromDisk = (input: {
  readonly codexHome: string
  readonly sessionId: string
}): CodexSession => {
  const id = input.sessionId.trim()
  if (id === "" || !isSafeCodexSessionIdSegment(id)) {
    return missing(id)
  }

  const lookup = findCodexSessionRollout({
    codexHome: input.codexHome,
    sessionId: id,
  })
  if (lookup.kind === "missing") {
    return missing(id)
  }
  if (lookup.kind === "unavailable") {
    return unavailable(id)
  }

  let raw: string
  try {
    raw = readFileSync(lookup.path, "utf8")
  } catch {
    return unavailable(id)
  }
  const fold = foldCodexRollout(raw)
  if (fold.sessionId !== id) {
    return unavailable(id)
  }

  return {
    id,
    availability: "available",
    model: fold.model,
    tokens: fold.tokens,
    cost: null,
    createdAt: fold.createdAt ?? lookup.indexCreatedAt,
    updatedAt: fold.updatedAt ?? lookup.indexUpdatedAt,
  }
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
    }),
  )
