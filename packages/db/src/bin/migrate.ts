import { Effect } from "effect"
import { TursoLive } from "@ready-for-agent/layer-turso-local"
import { runConfiguredMigrations } from "../lib/run-migrations.js"

const program = runConfiguredMigrations.pipe(
  Effect.provide(TursoLive),
  Effect.tap(() =>
    Effect.sync(() => {
      console.info("Database migrations applied")
    }),
  ),
)

await Effect.runPromise(program)
