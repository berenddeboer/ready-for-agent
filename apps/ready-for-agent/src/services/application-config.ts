import { homedir } from "node:os"
import { Config, Context, Effect, Layer, Option } from "effect"
import type { BrowserOpenEnv } from "../browser-open.ts"
import { resolveDefaultDatabasePath } from "../product-data-dir.ts"

const DEFAULT_GRAPHQL_URL = "http://127.0.0.1:6056/graphql"

const optionalString = (name: string) => Config.option(Config.string(name))

export class ApplicationConfig extends Context.Service<
  ApplicationConfig,
  {
    readonly graphqlUrl: string
    readonly databasePath: string
    readonly browserEnv: BrowserOpenEnv
    readonly platform: NodeJS.Platform
  }
>()("ready-for-agent/ApplicationConfig") {
  static readonly layer = Layer.effect(
    ApplicationConfig,
    Effect.gen(function* () {
      const graphqlUrl = yield* Config.string(
        "READY_FOR_AGENT_GRAPHQL_URL",
      ).pipe(Config.orElse(() => Config.succeed(DEFAULT_GRAPHQL_URL)))
      const homeOption = yield* optionalString("HOME")
      const xdgDataHome = yield* optionalString("XDG_DATA_HOME")
      const sqliteDatabasePath = yield* optionalString("SQLITE_DATABASE_PATH")
      const noBrowser = yield* optionalString("NO_BROWSER")
      const port = yield* optionalString("PORT")
      const homeValue = Option.getOrUndefined(homeOption)
      const platform = process.platform

      return {
        graphqlUrl,
        databasePath: resolveDefaultDatabasePath({
          env: {
            HOME: homeValue,
            XDG_DATA_HOME: Option.getOrUndefined(xdgDataHome),
            SQLITE_DATABASE_PATH: Option.getOrUndefined(sqliteDatabasePath),
          },
          platform,
          home: homeValue?.trim() || homedir(),
        }),
        browserEnv: {
          NO_BROWSER: Option.getOrUndefined(noBrowser),
          PORT: Option.getOrUndefined(port),
        },
        platform,
      }
    }),
  )
}
