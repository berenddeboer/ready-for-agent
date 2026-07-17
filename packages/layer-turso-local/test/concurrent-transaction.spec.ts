import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { connect } from "@tursodatabase/database"
import { ConfigProvider, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { makeTursoLive } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const tempDbPath = () =>
  `/tmp/test-turso-${Date.now()}-${Math.random().toString(36).slice(2)}.db`

const sqlQuery = (sql: string) => Object.assign([sql], { raw: [sql] })

const makeTestLayer = (dbPath: string) =>
  makeTursoLive().pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ SQLITE_DATABASE_PATH: dbPath }),
      ),
    ),
  )

const cleanupDb = async (dbPath: string) => {
  await unlink(dbPath).catch(() => {})
  await unlink(`${dbPath}-wal`).catch(() => {})
  await unlink(`${dbPath}-shm`).catch(() => {})
  await unlink(`${dbPath}-tshm`).catch(() => {})
}

describe("makeTursoLive", () => {
  it("uses BEGIN IMMEDIATE (write lock) transactions", async () => {
    const dbPath = tempDbPath()
    const TestLayer = makeTestLayer(dbPath)

    try {
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(sqlQuery("CREATE TABLE test_values (value TEXT NOT NULL)"))
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql(
                sqlQuery("INSERT INTO test_values (value) VALUES ('ok')"),
              )
            }),
          )

          return yield* sql(sqlQuery("SELECT value FROM test_values"))
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(rows).toEqual([{ value: "ok" }])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("serializes concurrent top-level transactions on one client", async () => {
    const dbPath = tempDbPath()
    const TestLayer = makeTestLayer(dbPath)

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(
            sqlQuery(
              "CREATE TABLE concurrent_tx (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            ),
          )

          const tx = (value: string) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql(
                  sqlQuery(
                    `INSERT INTO concurrent_tx (value) VALUES ('${value}')`,
                  ),
                )
                // Yield so a second fiber can race BEGIN while this tx is open.
                yield* Effect.sleep("20 millis")
                yield* sql(
                  sqlQuery(
                    `UPDATE concurrent_tx SET value = '${value}-done' WHERE value = '${value}'`,
                  ),
                )
              }),
            )

          const exits = yield* Effect.all([tx("a"), tx("b"), tx("c")], {
            concurrency: "unbounded",
            mode: "result",
          })

          const rows = yield* sql(
            sqlQuery("SELECT value FROM concurrent_tx ORDER BY id"),
          )
          return { exits, rows }
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(result.exits.every((exit) => exit._tag === "Success")).toBe(true)
      expect(result.rows).toEqual([
        { value: "a-done" },
        { value: "b-done" },
        { value: "c-done" },
      ])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("makes writes visible across long-lived clients", async () => {
    const dbPath = tempDbPath()
    const WriterLayer = makeTestLayer(dbPath)
    const ReaderLayer = makeTestLayer(dbPath)

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(sqlQuery("CREATE TABLE visible (value TEXT NOT NULL)"))
        }).pipe(Effect.provide(WriterLayer)),
      )

      const readVisible = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            return yield* sql(sqlQuery("SELECT value FROM visible"))
          }).pipe(Effect.provide(ReaderLayer)),
        )

      expect(await readVisible()).toEqual([])

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql(sqlQuery("INSERT INTO visible (value) VALUES ('ok')"))
            }),
          )
        }).pipe(Effect.provide(WriterLayer)),
      )

      expect(await readVisible()).toEqual([{ value: "ok" }])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("supports partial unique-index upserts", async () => {
    const dbPath = tempDbPath()
    const TestLayer = makeTestLayer(dbPath)

    try {
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(
            sqlQuery(
              "CREATE TABLE items (path TEXT NOT NULL, _deleted INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL)",
            ),
          )
          yield* sql(
            sqlQuery(
              "CREATE UNIQUE INDEX items_path_active ON items(path) WHERE _deleted = 0",
            ),
          )
          yield* sql.unsafe(
            "INSERT INTO items (path, _deleted, value) VALUES (?, 0, ?) ON CONFLICT (path) WHERE _deleted = 0 DO UPDATE SET value = excluded.value",
            ["/a", "one"],
          )
          yield* sql.unsafe(
            "INSERT INTO items (path, _deleted, value) VALUES (?, 0, ?) ON CONFLICT (path) WHERE _deleted = 0 DO UPDATE SET value = excluded.value",
            ["/a", "two"],
          )

          return yield* sql(sqlQuery("SELECT path, _deleted, value FROM items"))
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(rows).toEqual([{ path: "/a", _deleted: 0, value: "two" }])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("enables foreign keys on startup", async () => {
    const dbPath = tempDbPath()
    const TestLayer = makeTestLayer(dbPath)

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const pragma = yield* sql(sqlQuery("PRAGMA foreign_keys"))
          yield* sql(
            sqlQuery(
              "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
            ),
          )
          yield* sql(
            sqlQuery(
              "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))",
            ),
          )
          const insertOrphan = yield* Effect.exit(
            sql.unsafe(
              "INSERT INTO child (id, parent_id) VALUES (?, ?)",
              [1, 999],
            ),
          )
          return { pragma, insertOrphan }
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(result.pragma).toEqual([{ foreign_keys: 1 }])
      expect(result.insertOrphan._tag).toBe("Failure")
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("preserves duplicate selected columns in values mode", async () => {
    const dbPath = tempDbPath()
    const TestLayer = makeTestLayer(dbPath)

    try {
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(
            sqlQuery(
              "CREATE TABLE a (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            ),
          )
          yield* sql(
            sqlQuery(
              "CREATE TABLE b (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            ),
          )
          yield* sql.unsafe("INSERT INTO a (id, value) VALUES (?, ?)", [1, "a"])
          yield* sql.unsafe("INSERT INTO b (id, value) VALUES (?, ?)", [1, "b"])

          return yield* sql.unsafe(
            "SELECT a.id, b.id, a.value, b.value FROM a JOIN b ON a.id = b.id",
            [],
          ).values
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(rows).toEqual([[1, 1, "a", "b"]])
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("can be reopened by a default Turso connection after close", async () => {
    const dbPath = tempDbPath()
    const TestLayer = makeTestLayer(dbPath)

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(sqlQuery("CREATE TABLE reopen (value TEXT NOT NULL)"))
          yield* sql(sqlQuery("INSERT INTO reopen (value) VALUES ('ok')"))
        }).pipe(Effect.provide(TestLayer)),
      )

      const db = await connect(dbPath)
      try {
        const rows = await db.all("SELECT value FROM reopen")
        expect(rows).toEqual([{ value: "ok" }])
      } finally {
        await db.close()
      }
    } finally {
      await cleanupDb(dbPath)
    }
  })

  it("does not create a .db-tshm multiprocess coordination file", async () => {
    const dbPath = tempDbPath()
    const TestLayer = makeTestLayer(dbPath)

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql(sqlQuery("CREATE TABLE no_tshm (value TEXT NOT NULL)"))
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql(sqlQuery("INSERT INTO no_tshm (value) VALUES ('ok')"))
            }),
          )
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(existsSync(`${dbPath}-tshm`)).toBe(false)
    } finally {
      await cleanupDb(dbPath)
    }
  })
})
