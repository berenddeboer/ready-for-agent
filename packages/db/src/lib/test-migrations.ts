import { SqliteClient } from "@effect/sql-sqlite-bun"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { Effect } from "effect"

const rawSql = (query: string) => Object.assign([query], { raw: [query] })

export const runSqliteTestMigrations = (migrationsFolder: string) =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient
    const migrations = readMigrationFiles({ migrationsFolder })

    yield* sql`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `

    for (const migration of migrations) {
      for (const query of migration.sql) {
        if (query.trim().length > 0) {
          yield* sql(rawSql(query))
        }
      }

      yield* sql`
        INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
        VALUES (
          ${migration.hash},
          ${migration.folderMillis},
          ${migration.name},
          ${new Date().toISOString()}
        )
      `
    }
  })
