import { connect } from "@tursodatabase/database"
import { Context, Effect, Layer, Scope, Semaphore, Stream } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import {
  DatabaseConnectionInfo,
  DatabasePathConfig,
  normalizeDatabasePath,
  toTursoDatabasePath,
} from "./database-path.js"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

export const isSqliteBusyError = (error: SqlError): boolean =>
  error.message.includes("SQLITE_BUSY") ||
  error.message.includes("database is locked") ||
  error.message.includes("CONCURRENT")

export interface TursoClientOptions {
  readonly busy_timeout?: number
  readonly defaultQueryTimeout?: number
}

type TursoValue = string | number | bigint | boolean | Uint8Array | null
type TursoRow = Record<string, TursoValue>

const tursoRowValues = (row: TursoRow): TursoValue[] => {
  const values: TursoValue[] = []
  for (let index = 0; Object.hasOwn(row, String(index)); index++)
    values.push(row[String(index)] ?? null)
  return values.length > 0 ? values : Object.values(row)
}

const sqlError = (cause: unknown, operation: string) =>
  new SqlError({
    reason: classifySqliteError(cause, {
      message: `Failed to ${operation}`,
      operation,
    }),
  })

const makeClient = (path: string, options?: TursoClientOptions) =>
  Effect.gen(function* () {
    const databaseOptions: NonNullable<Parameters<typeof connect>[1]> = {
      experimental: ["multiprocess_wal"],
    }
    if (options?.defaultQueryTimeout !== undefined)
      databaseOptions.defaultQueryTimeout = options.defaultQueryTimeout
    const db = yield* Effect.tryPromise({
      try: () => connect(path, databaseOptions),
      catch: (cause) => sqlError(cause, "open database"),
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => db.close()).pipe(Effect.ignore),
    )

    yield* Effect.tryPromise({
      try: async () => {
        await db.all("PRAGMA foreign_keys = ON")
        await db.all("PRAGMA journal_mode = wal")
        const timeout = options?.busy_timeout ?? 1500
        if (timeout > 0) await db.all(`PRAGMA busy_timeout = ${timeout}`)
      },
      catch: (cause) => sqlError(cause, "configure database"),
    })

    const execute = (sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.tryPromise({
        try: async () => (await db.all(sql, [...params])) as TursoRow[],
        catch: (cause) => sqlError(cause, "execute statement"),
      })

    const connection: Connection = {
      execute: (sql, params, transformRows) =>
        execute(sql, params).pipe(
          Effect.map((rows) => (transformRows ? transformRows(rows) : rows)),
        ),
      executeRaw: execute,
      executeValues: (sql, params) =>
        execute(sql, params).pipe(
          Effect.map((rows) => rows.map(tursoRowValues)),
        ),
      executeValuesUnprepared: (sql, params) =>
        execute(sql, params).pipe(
          Effect.map((rows) => rows.map(tursoRowValues)),
        ),
      executeUnprepared: (sql, params, transformRows) =>
        execute(sql, params).pipe(
          Effect.map((rows) => (transformRows ? transformRows(rows) : rows)),
        ),
      executeStream: () => Stream.die("executeStream not implemented"),
    }
    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      Effect.withFiber((fiber) => {
        const scope = Context.getUnsafe(fiber.context, Scope.Scope)
        return Effect.as(
          Effect.tap(restore(semaphore.take(1)), () =>
            Scope.addFinalizer(scope, semaphore.release(1)),
          ),
          connection,
        )
      }),
    )

    return yield* Client.make({
      acquirer,
      transactionAcquirer,
      beginTransaction: "BEGIN IMMEDIATE",
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
    })
  })

export const makeTursoLive = (options?: TursoClientOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const databasePath = yield* DatabasePathConfig
      const client = yield* makeClient(
        toTursoDatabasePath(normalizeDatabasePath(databasePath)),
        options,
      )
      return Context.make(Client.SqlClient, client).pipe(
        Context.add(
          DatabaseConnectionInfo,
          normalizeDatabasePath(databasePath),
        ),
      )
    }),
  ).pipe(Layer.provide(Reactivity.layer))

export const TursoLive = makeTursoLive()
