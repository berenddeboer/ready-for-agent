import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  type AgentTurnTail,
  makeAgentTurnTail,
  missingAgentTurnTail,
  unavailableAgentTurnTail,
} from "@ready-for-agent/agent-backend"
import { type GrokHomeInput, resolveGrokHome } from "./grok-home.js"
import { readGrokUpdatesJsonlTail } from "./session-tail.js"

export const GROK_BACKEND = {
  id: AGENT_BACKEND_IDS.grok,
  label: "Grok Build",
} as const

/** 1 USD = 10^10 ticks (Grok headless `total_cost_usd_ticks` / `costUsdTicks`). */
export const GROK_COST_USD_TICKS_PER_USD = 10_000_000_000

/** Stable provider id for Grok Build models in Session Telemetry. */
export const GROK_SESSION_PROVIDER_ID = "xai"

export type SessionAvailability = "available" | "missing" | "unavailable"

export type SessionModel = {
  readonly providerId: string
  readonly id: string
  readonly thinkingLevel: string | null
}

export type SessionTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type GrokSession = {
  readonly id: string
  readonly availability: SessionAvailability
  readonly model: SessionModel | null
  readonly tokens: SessionTokens | null
  readonly cost: number | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export type GrokSessionStoreShape = {
  readonly getSession: (id: string) => Effect.Effect<GrokSession, never>
  readonly getTail: (id: string) => Effect.Effect<AgentTurnTail, never>
}

export class GrokSessionStore extends Context.Service<
  GrokSessionStore,
  GrokSessionStoreShape
>()("@ready-for-agent/grok/GrokSessionStore") {}

export type GrokSessionStoreOptions = GrokHomeInput

const unavailable = (id: string): GrokSession => ({
  id,
  availability: "unavailable",
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const missing = (id: string): GrokSession => ({
  id,
  availability: "missing",
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const intOrZero = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0
  }
  return Math.trunc(value)
}

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

/**
 * Normalize Grok timestamps (ISO with optional sub-ms fraction) to ISO-8601 ms.
 */
export const normalizeGrokTimestamp = (value: unknown): string | null => {
  const raw = nonEmptyString(value)
  if (raw === null) {
    return null
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    return raw
  }
  return new Date(ms).toISOString()
}

type UsageAccumulator = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  costTicks: number
}

const emptyUsage = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  costTicks: 0,
})

/**
 * Sum token/cost fields from a single `turn_completed` usage object.
 * Only parent-session `turn_completed.usage` is counted; nested
 * `subagent_finished.tokens_used` is intentionally ignored so subagent work is
 * not double-counted when the parent turn already includes it.
 */
export const accumulateTurnUsage = (
  acc: UsageAccumulator,
  usage: unknown,
): UsageAccumulator => {
  if (typeof usage !== "object" || usage === null) {
    return acc
  }
  const record = usage as Record<string, unknown>
  return {
    input: acc.input + intOrZero(record["inputTokens"]),
    output: acc.output + intOrZero(record["outputTokens"]),
    reasoning: acc.reasoning + intOrZero(record["reasoningTokens"]),
    cacheRead: acc.cacheRead + intOrZero(record["cachedReadTokens"]),
    costTicks: acc.costTicks + intOrZero(record["costUsdTicks"]),
  }
}

export const costUsdFromTicks = (costUsdTicks: number): number =>
  costUsdTicks / GROK_COST_USD_TICKS_PER_USD

/**
 * Scan JSONL session updates for `turn_completed` usage rows and sum them.
 * Line-oriented: each line is parsed independently; corrupt lines are skipped.
 */
export const sumTurnCompletedUsageFromJsonl = (
  jsonl: string,
): UsageAccumulator => {
  let acc = emptyUsage()
  const lines = jsonl.split("\n")
  for (const line of lines) {
    if (line.trim() === "") {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== "object" || parsed === null) {
        continue
      }
      const params = (parsed as Record<string, unknown>)["params"]
      if (typeof params !== "object" || params === null) {
        continue
      }
      const update = (params as Record<string, unknown>)["update"]
      if (typeof update !== "object" || update === null) {
        continue
      }
      const updateRecord = update as Record<string, unknown>
      if (updateRecord["sessionUpdate"] !== "turn_completed") {
        continue
      }
      acc = accumulateTurnUsage(acc, updateRecord["usage"])
    } catch {
      // Skip unreadable lines; partial files should still yield partial totals.
    }
  }
  return acc
}

type SummaryFields = {
  readonly model: SessionModel | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

const parseSummary = (raw: string): SummaryFields | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) {
      return null
    }
    const record = parsed as Record<string, unknown>
    const modelId = nonEmptyString(record["current_model_id"])
    const thinkingLevel = nonEmptyString(record["reasoning_effort"])
    const model: SessionModel | null =
      modelId === null
        ? null
        : {
            providerId: GROK_SESSION_PROVIDER_ID,
            id: modelId,
            thinkingLevel,
          }
    const createdAt = normalizeGrokTimestamp(record["created_at"])
    const updatedAt =
      normalizeGrokTimestamp(record["updated_at"]) ??
      normalizeGrokTimestamp(record["last_active_at"])
    return { model, createdAt, updatedAt }
  } catch {
    return null
  }
}

export type GrokSessionDirectoryLookup =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }

/**
 * Session ids must be a single relative path segment (Grok uses UUIDs).
 * Reject absolute paths, nested segments, and `..` so `path.join` cannot
 * escape `$GROK_HOME/sessions`.
 */
export const isSafeGrokSessionIdSegment = (sessionId: string): boolean => {
  if (sessionId === "" || sessionId === "." || sessionId === "..") {
    return false
  }
  if (isAbsolute(sessionId)) {
    return false
  }
  if (
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0") ||
    sessionId.includes("..")
  ) {
    return false
  }
  return basename(sessionId) === sessionId
}

/**
 * Locate `$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/` by session id.
 * Cwd segment is opaque; lookup walks one level under `sessions/`.
 * Absent sessions root or id → missing; unreadable root → unavailable.
 */
export const findGrokSessionDirectory = (
  grokHome: string,
  sessionId: string,
): GrokSessionDirectoryLookup => {
  const id = sessionId.trim()
  if (id === "" || !isSafeGrokSessionIdSegment(id)) {
    return { kind: "missing" }
  }
  const sessionsRoot = join(grokHome, "sessions")
  if (!existsSync(sessionsRoot)) {
    return { kind: "missing" }
  }
  let cwdEntries: string[]
  try {
    if (!statSync(sessionsRoot).isDirectory()) {
      return { kind: "unavailable" }
    }
    cwdEntries = readdirSync(sessionsRoot)
  } catch {
    return { kind: "unavailable" }
  }
  for (const cwdEntry of cwdEntries) {
    const candidate = join(sessionsRoot, cwdEntry, id)
    try {
      if (statSync(candidate).isDirectory()) {
        return { kind: "found", path: candidate }
      }
    } catch {
      // Not present or not a directory — keep searching.
    }
  }
  return { kind: "missing" }
}

const readSessionFromDisk = (
  grokHome: string,
  sessionId: string,
): GrokSession => {
  const id = sessionId.trim()
  if (id === "") {
    return missing("")
  }

  const lookup = findGrokSessionDirectory(grokHome, id)
  if (lookup.kind === "missing") {
    return missing(id)
  }
  if (lookup.kind === "unavailable") {
    return unavailable(id)
  }
  const sessionDir = lookup.path

  const summaryPath = join(sessionDir, "summary.json")
  if (!existsSync(summaryPath)) {
    return missing(id)
  }

  let summaryRaw: string
  try {
    summaryRaw = readFileSync(summaryPath, "utf8")
  } catch {
    return unavailable(id)
  }

  const summary = parseSummary(summaryRaw)
  if (summary === null) {
    return unavailable(id)
  }

  const updatesPath = join(sessionDir, "updates.jsonl")
  let usage = emptyUsage()
  if (existsSync(updatesPath)) {
    try {
      const updatesRaw = readFileSync(updatesPath, "utf8")
      usage = sumTurnCompletedUsageFromJsonl(updatesRaw)
    } catch {
      return unavailable(id)
    }
  }

  return {
    id,
    availability: "available",
    model: summary.model,
    tokens: {
      input: usage.input,
      output: usage.output,
      reasoning: usage.reasoning,
      cacheRead: usage.cacheRead,
      // Grok does not expose cache write tokens on turn_completed.usage.
      cacheWrite: 0,
    },
    cost: costUsdFromTicks(usage.costTicks),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  }
}

const readTailFromDisk = (
  grokHome: string,
  sessionId: string,
): AgentTurnTail => {
  const id = sessionId.trim()
  if (id === "" || !isSafeGrokSessionIdSegment(id)) {
    return missingAgentTurnTail(GROK_BACKEND)
  }

  const lookup = findGrokSessionDirectory(grokHome, id)
  if (lookup.kind === "missing") {
    return missingAgentTurnTail(GROK_BACKEND)
  }
  if (lookup.kind === "unavailable") {
    return unavailableAgentTurnTail(GROK_BACKEND)
  }

  const summaryPath = join(lookup.path, "summary.json")
  if (!existsSync(summaryPath)) {
    return missingAgentTurnTail(GROK_BACKEND)
  }
  try {
    const summaryRaw = readFileSync(summaryPath, "utf8")
    if (parseSummary(summaryRaw) === null) {
      return unavailableAgentTurnTail(GROK_BACKEND)
    }
  } catch {
    return unavailableAgentTurnTail(GROK_BACKEND)
  }

  const updatesPath = join(lookup.path, "updates.jsonl")
  if (!existsSync(updatesPath)) {
    return makeAgentTurnTail({
      availability: "available",
      backend: GROK_BACKEND,
      items: [],
    })
  }
  return readGrokUpdatesJsonlTail({
    updatesPath,
    sessionId: id,
    backend: GROK_BACKEND,
  })
}

export const makeGrokSessionStore = (
  shape: GrokSessionStoreShape,
): GrokSessionStoreShape => shape

export const GrokSessionStoreLive = (
  options: GrokSessionStoreOptions = {},
): Layer.Layer<GrokSessionStore> =>
  Layer.succeed(
    GrokSessionStore,
    makeGrokSessionStore({
      getSession: (id) =>
        Effect.sync(() => {
          const grokHome = resolveGrokHome(options)
          return readSessionFromDisk(grokHome, id)
        }),
      getTail: (id) =>
        Effect.sync(() => {
          const grokHome = resolveGrokHome(options)
          return readTailFromDisk(grokHome, id)
        }),
    }),
  )
