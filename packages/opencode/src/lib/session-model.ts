import { existsSync } from "node:fs"
import { Duration, Effect } from "effect"
import { Database } from "bun:sqlite"

const DEFAULT_BUSY_TIMEOUT_MS = 250
const DEFAULT_POLL_INTERVAL = Duration.millis(500)

export type ReassertOpencodeSessionModelResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "rewritten"; readonly previousModel: string | null }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }

const splitConfiguredModel = (
  model: string,
): { readonly providerId: string; readonly id: string } | null => {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    return null
  }
  return {
    providerId: model.slice(0, slash),
    id: model.slice(slash + 1),
  }
}

const parseSessionModelRecord = (
  raw: string | null,
): Record<string, unknown> | null => {
  if (raw === null || raw.trim() === "") {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) {
      return null
    }
    const record: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parsed)) {
      record[key] = value
    }
    return record
  } catch {
    return null
  }
}

const modelIdFromRecord = (record: Record<string, unknown>): string | null => {
  const id = record["id"]
  const providerId = record["providerID"] ?? record["providerId"]
  if (typeof id !== "string" || id.length === 0) {
    return null
  }
  if (typeof providerId !== "string" || providerId.length === 0) {
    return null
  }
  return `${providerId}/${id}`
}

const variantFromRecord = (record: Record<string, unknown>): string | null => {
  const variant = record["variant"]
  return typeof variant === "string" && variant.length > 0 ? variant : null
}

/**
 * Rewrite OpenCode's shared Session model when it has drifted from the
 * Agent Turn's configured Agent Model. The in-flight `opencode run` re-reads
 * this field between internal steps, so a concurrent Jump (or other attach)
 * that wrote an ambient default would otherwise hijack the still-running turn.
 */
export const reassertOpencodeSessionModel = (input: {
  readonly dbPath: string
  readonly sessionId: string
  readonly model: string
  readonly thinkingLevel: string | null
  readonly busyTimeoutMs?: number
}): ReassertOpencodeSessionModelResult => {
  const configured = splitConfiguredModel(input.model)
  if (configured === null) {
    return { kind: "unavailable" }
  }
  if (input.sessionId.trim() === "") {
    return { kind: "unavailable" }
  }
  if (input.dbPath !== ":memory:" && !existsSync(input.dbPath)) {
    return { kind: "unavailable" }
  }

  const busyTimeoutMs = input.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  let db: Database | undefined
  try {
    db = new Database(input.dbPath)
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`)
    const row = db
      .query(`SELECT model FROM session WHERE id = ? LIMIT 1`)
      .get(input.sessionId) as { readonly model: string | null } | null
    if (row === null || row === undefined) {
      return { kind: "missing" }
    }
    const existing = parseSessionModelRecord(row.model)
    const previous = existing === null ? null : modelIdFromRecord(existing)
    const nextId = `${configured.providerId}/${configured.id}`
    if (previous === nextId) {
      if (input.thinkingLevel === null) {
        return { kind: "unchanged" }
      }
      if (
        existing !== null &&
        variantFromRecord(existing) === input.thinkingLevel
      ) {
        return { kind: "unchanged" }
      }
    }
    const nextModel: Record<string, unknown> = {
      ...(existing ?? {}),
      id: configured.id,
      providerID: configured.providerId,
    }
    if (input.thinkingLevel !== null) {
      nextModel["variant"] = input.thinkingLevel
    } else {
      delete nextModel["variant"]
    }
    db.query(`UPDATE session SET model = ? WHERE id = ?`).run(
      JSON.stringify(nextModel),
      input.sessionId,
    )
    return {
      kind: "rewritten",
      previousModel: previous,
    }
  } catch {
    return { kind: "unavailable" }
  } finally {
    db?.close()
  }
}

export type ObserveOpencodeSessionModelInput = {
  readonly sessionId: string
  readonly model: string
  readonly thinkingLevel: string | null
  readonly resolveDbPath: () => string | null
  readonly pollInterval?: Duration.Input
  readonly busyTimeoutMs?: number
}

/**
 * Re-assert the configured Agent Model on the OpenCode Session for the
 * lifetime of an Agent Turn. Interrupted when the turn scope ends.
 */
export const observeOpencodeSessionModel = (
  input: ObserveOpencodeSessionModelInput,
): Effect.Effect<void> => {
  const pollInterval = input.pollInterval ?? DEFAULT_POLL_INTERVAL
  const busyTimeoutMs = input.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS

  return Effect.gen(function* () {
    for (;;) {
      const dbPath = input.resolveDbPath()
      if (dbPath !== null) {
        reassertOpencodeSessionModel({
          dbPath,
          sessionId: input.sessionId,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          busyTimeoutMs,
        })
      }
      yield* Effect.sleep(pollInterval)
    }
  })
}
