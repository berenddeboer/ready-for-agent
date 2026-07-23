import { existsSync } from "node:fs"
import { Context, Effect, Layer } from "effect"
import {
  type OpencodePathInput,
  resolveOpencodeDbPath,
} from "./opencode-db-path.js"
import { Database } from "bun:sqlite"

export type SessionAvailability = "available" | "missing" | "unavailable"

export type SessionModel = {
  readonly providerId: string
  readonly id: string
  readonly variant: string | null
}

export type SessionTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type OpencodeSession = {
  readonly id: string
  readonly availability: SessionAvailability
  readonly model: SessionModel | null
  readonly tokens: SessionTokens | null
  readonly cost: number | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

export type OpencodeSessionStoreShape = {
  readonly getSession: (id: string) => Effect.Effect<OpencodeSession, never>
}

export class OpencodeSessionStore extends Context.Service<
  OpencodeSessionStore,
  OpencodeSessionStoreShape
>()("@ready-for-agent/opencode/OpencodeSessionStore") {}

const DEFAULT_BUSY_TIMEOUT_MS = 250

type SessionRow = {
  readonly id: string
  readonly model: string | null
  readonly cost: number | null
  readonly tokens_input: number | null
  readonly tokens_output: number | null
  readonly tokens_reasoning: number | null
  readonly tokens_cache_read: number | null
  readonly tokens_cache_write: number | null
  readonly time_created: number | null
  readonly time_updated: number | null
}

const unavailable = (id: string): OpencodeSession => ({
  id,
  availability: "unavailable",
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const missing = (id: string): OpencodeSession => ({
  id,
  availability: "missing",
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

const toIso = (ms: number | null | undefined): string | null => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return null
  }
  return new Date(ms).toISOString()
}

const parseModel = (raw: string | null): SessionModel | null => {
  if (raw === null || raw.trim() === "") {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) {
      return null
    }
    const record = parsed as Record<string, unknown>
    const id = record["id"]
    const providerId = record["providerID"] ?? record["providerId"]
    if (typeof id !== "string" || id.length === 0) {
      return null
    }
    if (typeof providerId !== "string" || providerId.length === 0) {
      return null
    }
    const variantRaw = record["variant"]
    const variant =
      typeof variantRaw === "string" && variantRaw.length > 0
        ? variantRaw
        : null
    return { providerId, id, variant }
  } catch {
    return null
  }
}

const intOrZero = (value: number | null | undefined): number => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0
  }
  return Math.trunc(value)
}

const fromRow = (row: SessionRow): OpencodeSession => ({
  id: row.id,
  availability: "available",
  model: parseModel(row.model),
  tokens: {
    input: intOrZero(row.tokens_input),
    output: intOrZero(row.tokens_output),
    reasoning: intOrZero(row.tokens_reasoning),
    cacheRead: intOrZero(row.tokens_cache_read),
    cacheWrite: intOrZero(row.tokens_cache_write),
  },
  cost:
    row.cost === null || row.cost === undefined || !Number.isFinite(row.cost)
      ? 0
      : row.cost,
  createdAt: toIso(row.time_created),
  updatedAt: toIso(row.time_updated),
})

export type OpencodeSessionStoreOptions = {
  readonly dbPath?: string
  readonly pathInput?: OpencodePathInput
  readonly busyTimeoutMs?: number
}

const readSessionFromDb = (
  dbPath: string,
  sessionId: string,
  busyTimeoutMs: number,
): OpencodeSession => {
  // Absent DB file is IO failure (cannot open), not "row pruned".
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    return unavailable(sessionId)
  }

  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, create: false })
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`)
    const row = db
      .query(
        `SELECT id, model, cost,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write,
                time_created, time_updated
         FROM session
         WHERE id = ?
         LIMIT 1`,
      )
      .get(sessionId) as SessionRow | null
    if (row === null || row === undefined) {
      return missing(sessionId)
    }
    return fromRow(row)
  } catch {
    return unavailable(sessionId)
  } finally {
    db?.close()
  }
}

export const makeOpencodeSessionStore = (
  shape: OpencodeSessionStoreShape,
): OpencodeSessionStoreShape => shape

export const OpencodeSessionStoreLive = (
  options: OpencodeSessionStoreOptions = {},
): Layer.Layer<OpencodeSessionStore> => {
  let cachedDbPath: string | undefined =
    options.dbPath === undefined ? undefined : options.dbPath

  const resolvePath = (): string | null => {
    if (options.dbPath !== undefined) {
      return options.dbPath
    }
    if (cachedDbPath !== undefined) {
      return cachedDbPath
    }
    const resolved = resolveOpencodeDbPath(options.pathInput ?? {})
    // Only cache a successful path so a transient CLI failure can retry.
    if (resolved !== null) {
      cachedDbPath = resolved
    }
    return resolved
  }

  return Layer.succeed(
    OpencodeSessionStore,
    makeOpencodeSessionStore({
      getSession: (id) =>
        Effect.sync(() => {
          const path = resolvePath()
          if (path === null) {
            return unavailable(id)
          }
          const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
          return readSessionFromDb(path, id, busyTimeoutMs)
        }),
    }),
  )
}
