import { Effect } from "effect"
import { DatabaseLive } from "../lib/database-live.js"
import {
  logMigrationsAppliedIfAny,
  runConfiguredMigrations,
} from "../lib/run-migrations.js"

const program = runConfiguredMigrations().pipe(
  Effect.provide(DatabaseLive),
  Effect.tap((result) =>
    Effect.sync(() => {
      logMigrationsAppliedIfAny(result)
    }),
  ),
)

await Effect.runPromise(program)
