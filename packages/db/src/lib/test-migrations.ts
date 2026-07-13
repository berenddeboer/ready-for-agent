import { runMigrations } from "./run-migrations.js"

/**
 * Apply migrations for tests (in-memory or temp SQLite).
 * Delegates to the shared migrator used by production.
 */
export const runSqliteTestMigrations = (migrationsFolder: string) =>
  runMigrations(migrationsFolder)
