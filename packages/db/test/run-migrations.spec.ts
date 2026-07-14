import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteTest } from "../src/lib/database-test.js"
import { runMigrations } from "../src/lib/run-migrations.js"
import { afterEach, describe, expect, it } from "bun:test"

const temporaryDirectories: Array<string> = []

const migrationFolder = async (name: string, migrationSql: string) => {
  const root = await mkdtemp(join(tmpdir(), "db-migrations-"))
  temporaryDirectories.push(root)
  const folder = join(root, name)
  await mkdir(folder)
  await writeFile(join(folder, "migration.sql"), migrationSql)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("runMigrations", () => {
  it("rolls back all statements when a migration fails", async () => {
    const folder = await migrationFolder(
      "20260714120000_broken",
      [
        "CREATE TABLE partially_applied (id integer);",
        "--> statement-breakpoint",
        "INVALID SQL;",
      ].join("\n"),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const exit = yield* Effect.exit(runMigrations(folder))
        const tables = yield* sql`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'partially_applied'
        `

        expect(exit._tag).toBe("Failure")
        expect(tables).toEqual([])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
