import { TursoLive } from "@ready-for-agent/layer-turso-local"

/**
 * Production database layer: Turso local SQL client + typed Drizzle.
 *
 * Requires SQLITE_DATABASE_PATH in the environment / ConfigProvider.
 */
export const DatabaseLive = TursoLive
