import { Context, Layer } from "effect"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"

/**
 * Human-readable database connection info for logging.
 * Examples: "file://./data/app.db", "./data/app.db"
 */
export class DatabaseConnectionInfo extends Context.Tag(
  "@ready-for-agent/layer-turso-local/DatabaseConnectionInfo",
)<DatabaseConnectionInfo, string>() {}

export const normalizeDatabasePath = (path: string): string =>
  /^[a-z]+:/.test(path) ? path : `file://${path}`

export const isLocalFilePath = (path: string): boolean => {
  const protocol = path.match(/^([a-z]+):/)?.[1]
  return protocol === undefined || protocol === "file"
}

export const toTursoDatabasePath = (path: string): string => {
  if (path.startsWith("file://")) {
    return path.slice("file://".length)
  }

  if (path.startsWith("file:")) {
    return path.slice("file:".length)
  }

  return path
}

/**
 * Effect Config for the database path (SQLITE_DATABASE_PATH).
 */
export const DatabasePathConfig: Config.Config<string> = Config.string(
  "SQLITE_DATABASE_PATH",
)

export const DATABASE_PATH_NOT_CONFIGURED =
  "Database path not configured. Set SQLITE_DATABASE_PATH environment variable."

/**
 * Layer providing a ConfigProvider with the given database path.
 */
export const makeDatabaseConfigLayer = (databasePath: string) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([["SQLITE_DATABASE_PATH", databasePath]]),
    ).pipe(ConfigProvider.orElse(() => ConfigProvider.fromEnv())),
  )
