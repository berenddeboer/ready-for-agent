import { homedir } from "node:os"
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect"

const RequiredString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim() === "" ? "Expected a non-empty string" : undefined,
    ),
  ),
)

const Port = Schema.FiniteFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
)

const environmentValues = (
  environment: Partial<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

export const environmentConfigLayer = (
  environment: Partial<Record<string, string | undefined>>,
) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown(environmentValues(environment)),
  )

class ApplicationConfig extends Context.Service<
  ApplicationConfig,
  {
    readonly keymaxxerSidecarUrl: string | undefined
    readonly hostToolCwd: string
  }
>()("ready-for-agent/harness/ApplicationConfig") {
  static readonly layer = Layer.effect(
    ApplicationConfig,
    Effect.gen(function* () {
      const enabledValue = yield* Config.option(
        Config.string("KEYMAXXER_ENABLED"),
      )
      const enabled =
        Option.getOrUndefined(enabledValue)?.trim().toLowerCase() !== "false"
      const sidecarUrl = enabled
        ? yield* Config.schema(RequiredString, "KEYMAXXER_SIDECAR_URL")
        : undefined
      const home = yield* Config.option(Config.string("HOME"))

      return {
        keymaxxerSidecarUrl: sidecarUrl?.trim(),
        hostToolCwd: Option.getOrUndefined(home)?.trim() || homedir(),
      }
    }),
  )
}

export const loadApplicationConfig = (
  environment: Partial<Record<string, string | undefined>>,
) =>
  ApplicationConfig.pipe(
    Effect.provide(
      ApplicationConfig.layer.pipe(
        Layer.provide(environmentConfigLayer(environment)),
      ),
    ),
  )

export const loadPort = (
  environment: Partial<Record<string, string | undefined>>,
) =>
  Config.option(Config.schema(Port, "PORT")).pipe(
    Effect.map(Option.getOrElse(() => 6056)),
    Effect.provide(environmentConfigLayer(environment)),
  )
