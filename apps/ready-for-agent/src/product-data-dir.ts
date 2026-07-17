import { join } from "node:path"

export type ProductPathEnv = Partial<
  Record<"HOME" | "XDG_DATA_HOME" | "SQLITE_DATABASE_PATH", string | undefined>
>

export type ProductPathInput = {
  readonly env: ProductPathEnv
  readonly platform: string
  readonly home: string
}

/** Product application data directory (XDG on Linux, Application Support on macOS). */
export const resolveProductDataDir = ({
  env,
  platform,
  home,
}: ProductPathInput): string => {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ready-for-agent")
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim()
  if (xdgDataHome !== undefined && xdgDataHome !== "") {
    return join(xdgDataHome, "ready-for-agent")
  }

  return join(home, ".local", "share", "ready-for-agent")
}

/**
 * Database file path for product mode.
 * `SQLITE_DATABASE_PATH` wins when set; otherwise the product data dir.
 */
export const resolveDefaultDatabasePath = (input: ProductPathInput): string => {
  const override = input.env.SQLITE_DATABASE_PATH?.trim()
  if (override !== undefined && override !== "") {
    return override
  }

  return join(resolveProductDataDir(input), "ready-for-agent.db")
}
