import {
  defaultAgentBackendId,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import { Database } from "bun:sqlite"

const resolveFilePath = (databasePath: string): string | undefined => {
  if (
    databasePath === ":memory:" ||
    databasePath.startsWith("libsql:") ||
    databasePath.trim() === ""
  ) {
    return undefined
  }

  return databasePath.startsWith("file://")
    ? databasePath.slice("file://".length)
    : databasePath.startsWith("file:")
      ? databasePath.slice("file:".length)
      : databasePath
}

const normalizeBackendId = (
  value: string | null | undefined,
): string | undefined => {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined
  }
  return isSelectableAgentBackendId(trimmed) ? trimmed : undefined
}

const readConfigBackendId = (db: Database): string => {
  try {
    const configRow = db
      .query(
        `SELECT selected_agent_backend AS selectedAgentBackend
         FROM config
         WHERE id = 'default'
         LIMIT 1`,
      )
      .get() as { selectedAgentBackend?: string } | null
    return (
      normalizeBackendId(configRow?.selectedAgentBackend) ??
      defaultAgentBackendId
    )
  } catch {
    // Config table may be missing on first-run / pre-migration DBs.
    return defaultAgentBackendId
  }
}

/**
 * Read Harness Config's selected Agent Backend without starting the full app.
 * Missing DB or row defaults to OpenCode so first-run preflight stays correct.
 * Does not include Repository overrides (use {@link peekSelectedAgentBackendIds}).
 */
export const peekSelectedAgentBackendId = (databasePath: string): string => {
  const filePath = resolveFilePath(databasePath)
  if (filePath === undefined) {
    return defaultAgentBackendId
  }

  try {
    const db = new Database(filePath, { readonly: true, create: false })
    try {
      return readConfigBackendId(db)
    } finally {
      db.close()
    }
  } catch {
    return defaultAgentBackendId
  }
}

/**
 * Cold-start host-tools preflight set: harness config default unioned with
 * every distinct non-null Repository Agent Backend override.
 *
 * Missing DB / unreadable DB / empty config defaults safely to OpenCode only.
 * Unknown or blank backend ids are ignored (never required as host tools).
 */
export const peekSelectedAgentBackendIds = (
  databasePath: string,
): ReadonlyArray<string> => {
  const filePath = resolveFilePath(databasePath)
  if (filePath === undefined) {
    return [defaultAgentBackendId]
  }

  try {
    const db = new Database(filePath, { readonly: true, create: false })
    try {
      const ids = new Set<string>()
      ids.add(readConfigBackendId(db))

      try {
        const overrideRows = db
          .query(
            `SELECT DISTINCT selected_agent_backend AS selectedAgentBackend
             FROM repository
             WHERE selected_agent_backend IS NOT NULL
               AND trim(selected_agent_backend) != ''`,
          )
          .all() as ReadonlyArray<{ selectedAgentBackend?: string | null }>

        for (const row of overrideRows) {
          const id = normalizeBackendId(row.selectedAgentBackend)
          if (id !== undefined) {
            ids.add(id)
          }
        }
      } catch {
        // Repository table or column may be missing; keep config-only set.
      }

      // Stable order: product default first when present, then remaining ids sorted.
      const remaining = [...ids]
        .filter((id) => id !== defaultAgentBackendId)
        .sort()
      return ids.has(defaultAgentBackendId)
        ? [defaultAgentBackendId, ...remaining]
        : remaining
    } finally {
      db.close()
    }
  } catch {
    return [defaultAgentBackendId]
  }
}
