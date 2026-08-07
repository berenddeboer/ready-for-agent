import { existsSync } from "node:fs"
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

type PersistedBackendSelection =
  | { readonly kind: "unselected" }
  | { readonly kind: "selected"; readonly backendId: string }

const selectedBackend = (
  backendId: string | null | undefined,
): PersistedBackendSelection => ({
  kind: "selected",
  backendId: normalizeBackendId(backendId) ?? defaultAgentBackendId,
})

const readPersistedConfigBackendSelection = (
  db: Database,
): PersistedBackendSelection => {
  try {
    const configTable = db
      .query(
        `SELECT 1
         FROM sqlite_master
         WHERE type = 'table' AND name = 'config'
         LIMIT 1`,
      )
      .get()
    if (configTable === null) return { kind: "unselected" }

    const configRow = db
      .query(
        `SELECT selected_agent_backend AS selectedAgentBackend,
                agent_backend_configured_at AS agentBackendConfiguredAt
         FROM config
         WHERE id = 'default'
         LIMIT 1`,
      )
      .get() as {
      selectedAgentBackend?: string
      agentBackendConfiguredAt?: number | null
    } | null
    if (configRow === null || configRow.agentBackendConfiguredAt === null) {
      return { kind: "unselected" }
    }
    return selectedBackend(configRow.selectedAgentBackend)
  } catch {
    // Pre-marker Config rows belong to existing installations, where the
    // default was already enforced as a host-tool requirement.
    try {
      const configRow = db
        .query(
          `SELECT selected_agent_backend AS selectedAgentBackend
           FROM config
           WHERE id = 'default'
           LIMIT 1`,
        )
        .get() as { selectedAgentBackend?: string } | null
      return configRow === null
        ? { kind: "unselected" }
        : selectedBackend(configRow.selectedAgentBackend)
    } catch {
      // An unreadable existing DB must retain the conservative host preflight.
      return selectedBackend(defaultAgentBackendId)
    }
  }
}

const readConfigBackendId = (db: Database): string =>
  (() => {
    const selection = readPersistedConfigBackendSelection(db)
    return selection.kind === "selected"
      ? selection.backendId
      : defaultAgentBackendId
  })()

/**
 * Read Harness Config's selected Agent Backend without starting the full app.
 * Missing DB or row returns the product default for direct callers that need a
 * backend value. First-run preflight uses the plural peek below instead.
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
 * A bootstrap-seeded default is not a persisted selection until Settings saves
 * it. First-run can therefore reach Settings across restarts.
 * Unknown or blank backend ids are ignored (never required as host tools).
 */
export const peekSelectedAgentBackendIds = (
  databasePath: string,
): ReadonlyArray<string> => {
  if (databasePath.startsWith("libsql:")) {
    // The local SQLite peeker cannot inspect a remote URL; retain the existing
    // conservative preflight rather than treating it as a pristine database.
    return [defaultAgentBackendId]
  }
  const filePath = resolveFilePath(databasePath)
  if (filePath === undefined) {
    return []
  }
  if (!existsSync(filePath)) {
    return []
  }

  try {
    const db = new Database(filePath, { readonly: true, create: false })
    try {
      const ids = new Set<string>()
      const configSelection = readPersistedConfigBackendSelection(db)
      if (configSelection.kind === "selected") {
        ids.add(configSelection.backendId)
      }

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

export type RepositoryForge = "github" | "gitlab"

/**
 * Cold-start Forge preflight set from persisted Repositories.
 *
 * Missing/empty databases have no Repository tool requirements. A legacy
 * pre-forge-identity repository table is conservatively GitHub when non-empty,
 * matching the migration backfill.
 */
export const peekRepositoryForges = (
  databasePath: string,
): ReadonlyArray<RepositoryForge> => {
  const filePath = resolveFilePath(databasePath)
  if (filePath === undefined) {
    return []
  }

  try {
    const db = new Database(filePath, { readonly: true, create: false })
    try {
      const table = db
        .query(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name = 'repository'
           LIMIT 1`,
        )
        .get() as { readonly name: string } | null
      if (table === null) {
        return []
      }

      try {
        const rows = db
          .query(`SELECT DISTINCT lower(trim(forge)) AS forge FROM repository`)
          .all() as ReadonlyArray<{ readonly forge: string | null }>
        const found = new Set(
          rows
            .map((row) => row.forge)
            .filter(
              (forge): forge is RepositoryForge =>
                forge === "github" || forge === "gitlab",
            ),
        )
        return (["github", "gitlab"] as const).filter((forge) =>
          found.has(forge),
        )
      } catch {
        const row = db
          .query(`SELECT COUNT(*) AS count FROM repository`)
          .get() as { readonly count: number } | null
        return Number(row?.count ?? 0) > 0 ? ["github"] : []
      }
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}
