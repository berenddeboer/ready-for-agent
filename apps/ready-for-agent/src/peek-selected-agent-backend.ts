import { defaultAgentBackendId } from "@ready-for-agent/agent-backend"
import { Database } from "bun:sqlite"

/**
 * Read Harness Config's selected Agent Backend without starting the full app.
 * Missing DB or row defaults to OpenCode so first-run preflight stays correct.
 */
export const peekSelectedAgentBackendId = (databasePath: string): string => {
  if (
    databasePath === ":memory:" ||
    databasePath.startsWith("libsql:") ||
    databasePath.trim() === ""
  ) {
    return defaultAgentBackendId
  }

  const filePath = databasePath.startsWith("file://")
    ? databasePath.slice("file://".length)
    : databasePath.startsWith("file:")
      ? databasePath.slice("file:".length)
      : databasePath

  try {
    const db = new Database(filePath, { readonly: true, create: false })
    try {
      const row = db
        .query(
          `SELECT selected_agent_backend AS selectedAgentBackend
           FROM config
           WHERE id = 'default'
           LIMIT 1`,
        )
        .get() as { selectedAgentBackend?: string } | null
      const value = row?.selectedAgentBackend?.trim()
      return value !== undefined && value.length > 0
        ? value
        : defaultAgentBackendId
    } finally {
      db.close()
    }
  } catch {
    return defaultAgentBackendId
  }
}
