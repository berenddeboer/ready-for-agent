import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Config, Context, Option } from "effect"

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

export type ProductDataDirInput = {
  readonly env: {
    readonly HOME?: string
    readonly XDG_DATA_HOME?: string
  }
  readonly platform: string
  readonly home: string
}

/** Product application data directory (XDG on Linux, Application Support on macOS). */
export const resolveProductDataDir = ({
  env,
  platform,
  home,
}: ProductDataDirInput): string => {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ready-for-agent")
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim()
  if (xdgDataHome !== undefined && xdgDataHome !== "") {
    return join(xdgDataHome, "ready-for-agent")
  }

  return join(home, ".local", "share", "ready-for-agent")
}

/** Product default SQLite path when SQLITE_DATABASE_PATH is unset. */
export const resolveProductDatabasePath = (
  input: ProductDataDirInput,
): string => join(resolveProductDataDir(input), "ready-for-agent.db")

/**
 * Default product database path via Config (`HOME`, `XDG_DATA_HOME`).
 * ConfigProvider overrides cover these keys; `homedir()` is only the last
 * resort when `HOME` is absent from the provider.
 */
const nonEmptyConfigString = (
  name: string,
): Config.Config<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(
    Config.map((value) =>
      Option.flatMap(value, (raw) => {
        const trimmed = raw.trim()
        return trimmed === "" ? Option.none() : Option.some(trimmed)
      }),
    ),
  )

const productDatabasePathConfig: Config.Config<string> = Config.all({
  HOME: nonEmptyConfigString("HOME"),
  XDG_DATA_HOME: nonEmptyConfigString("XDG_DATA_HOME"),
}).pipe(
  Config.map(({ HOME, XDG_DATA_HOME }) => {
    const home = Option.getOrElse(HOME, () => homedir())
    return resolveProductDatabasePath({
      env: {
        HOME: Option.getOrUndefined(HOME),
        XDG_DATA_HOME: Option.getOrUndefined(XDG_DATA_HOME),
      },
      platform: process.platform,
      home,
    })
  }),
)

/**
 * Effect Config for the database path (SQLITE_DATABASE_PATH).
 * Defaults to the product XDG / platform data directory when unset.
 */
export const DatabasePathConfig: Config.Config<string> = Config.string(
  "SQLITE_DATABASE_PATH",
).pipe(Config.orElse(() => productDatabasePathConfig))

export const DATABASE_PATH_NOT_CONFIGURED =
  "Database path not configured. Set SQLITE_DATABASE_PATH environment variable."
