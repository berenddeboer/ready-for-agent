import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteTest } from "../src/lib/database-test.js"
import { describe, expect, it } from "bun:test"

describe("SqliteTest foreign keys", () => {
  it("enables foreign keys on startup", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const pragma = yield* sql`PRAGMA foreign_keys`
        yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`
        yield* sql`CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))`
        const insertOrphan = yield* Effect.exit(
          sql`INSERT INTO child (id, parent_id) VALUES (1, 999)`,
        )
        return { pragma, insertOrphan }
      }).pipe(Effect.provide(SqliteTest)),
    )

    expect(result.pragma).toEqual([{ foreign_keys: 1 }])
    expect(result.insertOrphan._tag).toBe("Failure")
  })
})
