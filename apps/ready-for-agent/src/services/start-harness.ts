import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { isStandaloneExecutable } from "@ready-for-agent/keymaxxer-service"
import {
  openBrowserWhenReady,
  resolveUiUrl,
  shouldOpenBrowser,
} from "../browser-open.ts"
import { checkHostTools } from "../host-tools-preflight.ts"
import { bootStandaloneProduction } from "../standalone-boot.ts"
import { ApplicationConfig } from "./application-config.ts"

export class StartHarnessFailed extends Schema.TaggedErrorClass<StartHarnessFailed>()(
  "StartHarnessFailed",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail
  }
}

export type StartHarnessOptions = {
  readonly noOpen?: boolean
}

const databaseFilePath = (databasePath: string): string | undefined => {
  if (databasePath === ":memory:" || databasePath.startsWith("libsql:")) {
    return undefined
  }
  const filePath = databasePath.startsWith("file://")
    ? databasePath.slice("file://".length)
    : databasePath.startsWith("file:")
      ? databasePath.slice("file:".length)
      : databasePath
  return filePath === ":memory:" ? undefined : filePath
}

const fail = (cause: unknown): StartHarnessFailed =>
  cause instanceof StartHarnessFailed
    ? cause
    : new StartHarnessFailed({
        detail: cause instanceof Error ? cause.message : String(cause),
      })

export class StartHarness extends Context.Service<
  StartHarness,
  {
    readonly start: (
      options?: StartHarnessOptions,
    ) => Effect.Effect<void, StartHarnessFailed>
  }
>()("ready-for-agent/StartHarness") {
  static readonly layer = Layer.effect(
    StartHarness,
    Effect.gen(function* () {
      const config = yield* ApplicationConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const modulePath = yield* path.fromFileUrl(new URL(import.meta.url))

      const findMonorepoRoot = Effect.fn("StartHarness.findMonorepoRoot")(
        function* () {
          let current = path.resolve(path.dirname(modulePath))
          for (let i = 0; i < 10; i++) {
            const [hasNx, hasHarness] = yield* Effect.all([
              fs.exists(path.join(current, "nx.json")),
              fs.exists(path.join(current, "apps", "harness", "project.json")),
            ])
            if (hasNx && hasHarness) return current

            const parent = path.dirname(current)
            if (parent === current) return undefined
            current = parent
          }
          return undefined
        },
      )

      const runPreflight = Effect.fn("StartHarness.runPreflight")(function* () {
        const result = checkHostTools((command) => Bun.which(command) !== null)
        if (!result.ok) {
          return yield* new StartHarnessFailed({ detail: result.message })
        }
      })

      const ensureDatabaseParentDir = Effect.fn(
        "StartHarness.ensureDatabaseParentDir",
      )(function* () {
        const filePath = databaseFilePath(config.databasePath)
        if (filePath !== undefined) {
          yield* fs.makeDirectory(path.dirname(path.resolve(filePath)), {
            recursive: true,
          })
        }
      })

      const startStandalone = Effect.fn("StartHarness.startStandalone")(
        function* (options: StartHarnessOptions) {
          yield* runPreflight()
          yield* ensureDatabaseParentDir()

          // The embedded harness lifecycle owns a Promise-based server host.
          return yield* Effect.tryPromise({
            try: () =>
              bootStandaloneProduction({
                noOpen: options.noOpen === true,
                databasePath: config.databasePath,
                browserEnv: config.browserEnv,
              }),
            catch: fail,
          })
        },
      )

      const startMonorepo = Effect.fn("StartHarness.startMonorepo")(function* (
        options: StartHarnessOptions,
      ) {
        yield* runPreflight()
        const root = yield* findMonorepoRoot()
        if (root === undefined) {
          return yield* new StartHarnessFailed({
            detail:
              "Could not find the ready-for-agent monorepo root (expected nx.json and apps/harness).",
          })
        }
        yield* ensureDatabaseParentDir()

        if (
          shouldOpenBrowser({
            noOpenFlag: options.noOpen === true,
            env: config.browserEnv,
          })
        ) {
          openBrowserWhenReady(config.platform, resolveUiUrl(config.browserEnv))
        }

        const code = yield* spawner.exitCode(
          ChildProcess.make("bun", ["nx", "run", "harness:dev"], {
            cwd: root,
            env: { SQLITE_DATABASE_PATH: config.databasePath },
            extendEnv: true,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        if (Number(code) !== 0) {
          return yield* new StartHarnessFailed({
            detail: `Harness exited with code ${code}`,
          })
        }
      })

      const start = Effect.fn("StartHarness.start")(function* (
        options: StartHarnessOptions = {},
      ) {
        yield* isStandaloneExecutable()
          ? startStandalone(options)
          : startMonorepo(options)
      }, Effect.mapError(fail))

      return { start }
    }),
  )
}
