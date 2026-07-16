import { isAbsolute, resolve } from "node:path"
import { Context } from "effect"
import * as Config from "effect/Config"

/**
 * Human-readable database connection info for logging.
 * Examples: "file://./data/app.db", "./data/app.db"
 */
export const DatabaseConnectionInfo = Context.Service<string>(
  "@ready-for-agent/layer-turso-local/DatabaseConnectionInfo",
)

export const normalizeDatabasePath = (path: string): string =>
  /^[a-z]+:/.test(path) ? path : `file://${path}`

export const isLocalFilePath = (path: string): boolean => {
  const protocol = path.match(/^([a-z]+):/)?.[1]
  return protocol === undefined || protocol === "file"
}

const resolveLocalFilePath = (path: string): string =>
  path === ":memory:" || isAbsolute(path) ? path : resolve(path)

export const toTursoDatabasePath = (path: string): string => {
  if (path.startsWith("file://")) {
    return resolveLocalFilePath(path.slice("file://".length))
  }

  if (path.startsWith("file:")) {
    return resolveLocalFilePath(path.slice("file:".length))
  }

  return resolveLocalFilePath(path)
}

/**
 * Effect Config for the database path (SQLITE_DATABASE_PATH).
 */
export const DatabasePathConfig: Config.Config<string> = Config.string(
  "SQLITE_DATABASE_PATH",
)

export const DATABASE_PATH_NOT_CONFIGURED =
  "Database path not configured. Set SQLITE_DATABASE_PATH environment variable."
