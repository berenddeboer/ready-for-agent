import { Layer } from "effect"
import { TursoLive } from "@ready-for-agent/layer-turso-local"
import { TypedSqliteDrizzleLayer } from "./typed-drizzle.js"

/**
 * Production database layer: Turso local SQL client + typed Drizzle.
 *
 * Requires SQLITE_DATABASE_PATH in the environment / ConfigProvider.
 */
export const DatabaseLive = TypedSqliteDrizzleLayer.pipe(
  Layer.provideMerge(TursoLive),
)
