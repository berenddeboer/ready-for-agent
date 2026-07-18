import { spawn } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Schema } from "effect"
import { isStandaloneExecutable } from "@ready-for-agent/keymaxxer-service"
import {
  browserOpenCommand,
  resolveUiUrl,
  shouldOpenBrowser,
} from "../browser-open.ts"
import { checkHostTools } from "../host-tools-preflight.ts"
import { resolveDefaultDatabasePath } from "../product-data-dir.ts"
import { bootStandaloneProduction } from "../standalone-boot.ts"

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

const findMonorepoRoot = (
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined => {
  let current = resolve(startDir)
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(current, "nx.json")) &&
      existsSync(join(current, "apps", "harness", "project.json"))
    ) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return undefined
    }
    current = parent
  }
  return undefined
}

const commandExists = (command: string) => Bun.which(command) !== null

const ensureDatabaseParentDir = (databasePath: string) => {
  if (databasePath === ":memory:" || databasePath.startsWith("libsql:")) {
    return
  }
  const filePath = databasePath.startsWith("file://")
    ? databasePath.slice("file://".length)
    : databasePath.startsWith("file:")
      ? databasePath.slice("file:".length)
      : databasePath
  if (filePath === ":memory:") {
    return
  }
  mkdirSync(dirname(resolve(filePath)), { recursive: true })
}

const openBrowserWhenReady = (url: string) => {
  const { command, args } = browserOpenCommand(process.platform, url)
  const deadline = Date.now() + 60_000

  const tryOpen = async () => {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { redirect: "manual" })
        void response.body?.cancel()
        if (response.status > 0) {
          spawn(command, [...args], {
            detached: true,
            stdio: "ignore",
          }).unref()
          return
        }
      } catch {
        // Port not ready yet.
      }
      await Bun.sleep(250)
    }
  }

  void tryOpen()
}

const resolveProductDatabasePath = () => {
  const home = process.env.HOME?.trim() || homedir()
  return resolveDefaultDatabasePath({
    env: {
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      SQLITE_DATABASE_PATH: process.env.SQLITE_DATABASE_PATH,
    },
    platform: process.platform,
    home,
  })
}

const startStandaloneProduction = (options: StartHarnessOptions) =>
  Effect.tryPromise({
    try: async () => {
      const preflight = checkHostTools(commandExists)
      if (!preflight.ok) {
        throw new StartHarnessFailed({ detail: preflight.message })
      }

      const databasePath = resolveProductDatabasePath()
      try {
        ensureDatabaseParentDir(databasePath)
      } catch (error) {
        throw new StartHarnessFailed({
          detail:
            error instanceof Error
              ? error.message
              : `Could not create database directory for ${databasePath}`,
        })
      }

      process.env.SQLITE_DATABASE_PATH = databasePath
      await bootStandaloneProduction({ noOpen: options.noOpen === true })
    },
    catch: (cause) => {
      if (cause instanceof StartHarnessFailed) return cause
      return new StartHarnessFailed({
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    },
  })

const startMonorepoDevelopment = (options: StartHarnessOptions) =>
  Effect.callback<void, StartHarnessFailed>((resume) => {
    const preflight = checkHostTools(commandExists)
    if (!preflight.ok) {
      resume(
        Effect.fail(
          new StartHarnessFailed({
            detail: preflight.message,
          }),
        ),
      )
      return
    }

    const root = findMonorepoRoot()
    if (root === undefined) {
      resume(
        Effect.fail(
          new StartHarnessFailed({
            detail:
              "Could not find the ready-for-agent monorepo root (expected nx.json and apps/harness).",
          }),
        ),
      )
      return
    }

    const databasePath = resolveProductDatabasePath()
    try {
      ensureDatabaseParentDir(databasePath)
    } catch (error) {
      resume(
        Effect.fail(
          new StartHarnessFailed({
            detail:
              error instanceof Error
                ? error.message
                : `Could not create database directory for ${databasePath}`,
          }),
        ),
      )
      return
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SQLITE_DATABASE_PATH: databasePath,
    }

    const child = spawn("bun", ["nx", "run", "harness:dev"], {
      cwd: root,
      env,
      stdio: "inherit",
    })

    if (
      shouldOpenBrowser({
        noOpenFlag: options.noOpen === true,
        env: {
          NO_BROWSER: process.env.NO_BROWSER,
          PORT: process.env.PORT,
        },
      })
    ) {
      openBrowserWhenReady(
        resolveUiUrl({
          NO_BROWSER: process.env.NO_BROWSER,
          PORT: process.env.PORT,
        }),
      )
    }

    child.on("error", (error) => {
      resume(
        Effect.fail(
          new StartHarnessFailed({
            detail: error.message,
          }),
        ),
      )
    })

    child.on("exit", (code, signal) => {
      if (signal) {
        resume(
          Effect.fail(
            new StartHarnessFailed({
              detail: `Harness exited via signal ${signal}`,
            }),
          ),
        )
        return
      }
      if (code !== 0 && code !== null) {
        resume(
          Effect.fail(
            new StartHarnessFailed({
              detail: `Harness exited with code ${code}`,
            }),
          ),
        )
        return
      }
      resume(Effect.void)
    })
  })

export class StartHarness extends Context.Service<
  StartHarness,
  {
    readonly start: (
      options?: StartHarnessOptions,
    ) => Effect.Effect<void, StartHarnessFailed>
  }
>()("ready-for-agent/StartHarness") {
  static readonly layer = Layer.succeed(StartHarness, {
    start: (options = {}) =>
      isStandaloneExecutable()
        ? startStandaloneProduction(options)
        : startMonorepoDevelopment(options),
  })
}
