import { Effect } from "effect"
import { DatabaseLive } from "../lib/database-live.js"
import { runConfiguredMigrations } from "../lib/run-migrations.js"

const program = runConfiguredMigrations().pipe(
  Effect.provide(DatabaseLive),
  Effect.tap(() =>
    Effect.sync(() => {
      console.info("Database migrations applied")
    }),
  ),
)

await Effect.runPromise(program)
