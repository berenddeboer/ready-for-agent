import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Schema } from "effect"

export class StartHarnessFailed extends Schema.TaggedErrorClass<StartHarnessFailed>()(
  "StartHarnessFailed",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail
  }
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

export class StartHarness extends Context.Service<
  StartHarness,
  {
    readonly start: Effect.Effect<void, StartHarnessFailed>
  }
>()("ready-for-agent/StartHarness") {
  static readonly layer = Layer.succeed(StartHarness, {
    start: Effect.callback<void, StartHarnessFailed>((resume) => {
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

      const child = spawn("bun", ["nx", "run", "harness:dev"], {
        cwd: root,
        env: process.env,
        stdio: "inherit",
      })

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
    }),
  })
}
