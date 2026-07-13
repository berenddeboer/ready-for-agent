import { unlink } from "node:fs/promises"
import * as SqlClient from "@effect/sql/SqlClient"
import { ConfigProvider, Effect, Layer } from "effect"
import { makeTursoLive } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const tempDbPath = () =>
  `/tmp/test-turso-${Date.now()}-${Math.random().toString(36).slice(2)}.db`

const sqlQuery = (sql: string) => Object.assign([sql], { raw: [sql] })

const cleanupDb = async (dbPath: string) => {
  await unlink(dbPath).catch(() => {})
  await unlink(`${dbPath}-wal`).catch(() => {})
  await unlink(`${dbPath}-shm`).catch(() => {})
}

describe("makeTursoLive", () => {
  it("uses BEGIN IMMEDIATE (write lock) transactions", async () => {
    const dbPath = tempDbPath()
    const ConfigLayer = Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
    )
    const TestLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

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

  it("makes writes visible across long-lived clients", async () => {
    const dbPath = tempDbPath()
    const ConfigLayer = Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
    )
    const WriterLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))
    const ReaderLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

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
    const ConfigLayer = Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
    )
    const TestLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

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

  it("preserves duplicate selected columns in values mode", async () => {
    const dbPath = tempDbPath()
    const ConfigLayer = Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
    )
    const TestLayer = makeTursoLive().pipe(Layer.provide(ConfigLayer))

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
})
