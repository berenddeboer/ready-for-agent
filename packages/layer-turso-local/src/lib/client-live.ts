import * as Reactivity from "@effect/experimental/Reactivity"
import * as Client from "@effect/sql/SqlClient"
import type { Connection } from "@effect/sql/SqlConnection"
import { SqlError } from "@effect/sql/SqlError"
import * as Statement from "@effect/sql/Statement"
import { type Database, connect } from "@tursodatabase/database"
import * as Config from "effect/Config"
import type { ConfigError } from "effect/ConfigError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import {
  DatabaseConnectionInfo,
  DatabasePathConfig,
  normalizeDatabasePath,
  toTursoDatabasePath,
} from "./database-path.js"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

export const isSqliteBusyError = (error: SqlError): boolean => {
  if (
    error.message.includes("SQLITE_BUSY") ||
    error.message.includes("database is locked") ||
    error.message.includes("CONCURRENT")
  ) {
    return true
  }

  let current: unknown = error.cause
  while (current) {
    if (current instanceof Error) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked") ||
        current.message.includes("CONCURRENT")
      ) {
        return true
      }
      current = current.cause
    } else if (
      typeof current === "string" &&
      (current.includes("SQLITE_BUSY") ||
        current.includes("database is locked") ||
        current.includes("CONCURRENT"))
    ) {
      return true
    } else {
      break
    }
  }

  return false
}

const ConnectionInfoLayer = Layer.effect(
  DatabaseConnectionInfo,
  DatabasePathConfig.pipe(Config.map(normalizeDatabasePath)),
)

const TursoTransaction = Context.GenericTag<
  readonly [TursoConnection, counter: number]
>("@ready-for-agent/layer-turso-local/TursoTransaction")

interface TursoConnection extends Connection {
  readonly beginTransaction: Effect.Effect<TursoConnection, SqlError>
  readonly commit: Effect.Effect<void, SqlError>
  readonly rollback: Effect.Effect<void, SqlError>
  readonly close: Effect.Effect<void, never>
}

export interface TursoClientOptions {
  readonly busy_timeout?: number
  readonly defaultQueryTimeout?: number
}

type TursoValue = string | number | bigint | boolean | Uint8Array | null
type TursoRow = Record<string, TursoValue>

const tursoRowValues = (row: TursoRow): TursoValue[] => {
  // Turso exposes positional values as stringified numeric keys for values-mode
  // rows; named keys alone cannot preserve duplicate-column ordering.
  const values: TursoValue[] = []
  for (let index = 0; Object.hasOwn(row, String(index)); index++) {
    values.push(row[String(index)] ?? null)
  }

  return values.length > 0 ? values : Object.values(row)
}

const makeDatabase = (
  path: string,
  options: TursoClientOptions | undefined,
): Effect.Effect<Database, SqlError> =>
  Effect.tryPromise({
    try: () => {
      const databaseOptions: NonNullable<Parameters<typeof connect>[1]> = {
        experimental: ["multiprocess_wal"],
      }
      if (options?.defaultQueryTimeout !== undefined) {
        databaseOptions.defaultQueryTimeout = options.defaultQueryTimeout
      }

      return connect(path, databaseOptions)
    },
    catch: (cause) =>
      new SqlError({ cause, message: "Failed to open database" }),
  })

const closeDatabase = (db: Database): Effect.Effect<void, never> =>
  Effect.promise(() => db.close()).pipe(Effect.ignore)

const makeClient = (
  path: string,
  options?: TursoClientOptions,
): Effect.Effect<
  Client.SqlClient,
  SqlError,
  Scope.Scope | Reactivity.Reactivity
> =>
  Effect.gen(function* () {
    const compiler = Statement.makeCompilerSqlite()
    const spanAttributes: Array<[string, unknown]> = [
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ]
    const rootDb = yield* makeDatabase(path, options)
    yield* Effect.addFinalizer(() => closeDatabase(rootDb))

    class TursoConnectionImpl implements TursoConnection {
      private pragmasExecuted = false

      constructor(
        private readonly db: Database,
        private readonly runPragmas: boolean,
      ) {}

      private ensurePragmas(): Effect.Effect<void, SqlError> {
        if (this.pragmasExecuted || !this.runPragmas) {
          return Effect.void
        }

        return Effect.gen(this, function* () {
          yield* this.runDirect("PRAGMA foreign_keys = ON", [])
          yield* this.runDirect("PRAGMA journal_mode = wal", [])
          const timeout = options?.busy_timeout ?? 1500
          if (timeout > 0) {
            yield* this.runDirect(`PRAGMA busy_timeout = ${timeout}`, [])
          }
          this.pragmasExecuted = true
        })
      }

      private runDirect(sql: string, params: ReadonlyArray<unknown>) {
        return Effect.tryPromise({
          try: () => this.db.all(sql, [...params]) as Promise<TursoRow[]>,
          catch: (cause) =>
            new SqlError({ cause, message: "Failed to execute statement" }),
        })
      }

      private runValuesDirect(sql: string, params: ReadonlyArray<unknown>) {
        return Effect.tryPromise({
          try: async () =>
            ((await this.db.all(sql, [...params])) as TursoRow[]).map((row) =>
              tursoRowValues(row),
            ),
          catch: (cause) =>
            new SqlError({ cause, message: "Failed to execute statement" }),
        })
      }

      private runValues(sql: string, params: ReadonlyArray<unknown> = []) {
        return Effect.gen(this, function* () {
          yield* this.ensurePragmas()
          return yield* this.runValuesDirect(sql, params)
        })
      }

      run(sql: string, params: ReadonlyArray<unknown> = []) {
        return Effect.gen(this, function* () {
          yield* this.ensurePragmas()
          return yield* this.runDirect(sql, params)
        })
      }

      runRaw(sql: string, params: ReadonlyArray<unknown> = []) {
        return this.run(sql, params)
      }

      execute(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows:
          | (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>)
          | undefined,
      ) {
        return transformRows
          ? Effect.map(this.run(sql, params), transformRows)
          : this.run(sql, params)
      }

      executeRaw(sql: string, params: ReadonlyArray<unknown>) {
        return this.runRaw(sql, params)
      }

      executeValues(sql: string, params: ReadonlyArray<unknown>) {
        return this.runValues(sql, params)
      }

      executeUnprepared(
        sql: string,
        params: ReadonlyArray<unknown>,
        transformRows:
          | (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>)
          | undefined,
      ) {
        return this.execute(sql, params, transformRows)
      }

      executeStream() {
        return Effect.dieMessage("executeStream not implemented")
      }

      get beginTransaction(): Effect.Effect<TursoConnection, SqlError> {
        return Effect.gen(this, function* () {
          const transactionDb = yield* makeDatabase(path, options)
          const connection = new TursoConnectionImpl(transactionDb, true)
          yield* connection.ensurePragmas()
          // IMMEDIATE acquires the write lock up front (needed for queue claims
          // and other atomic RMW). Turso multiprocess_wal supports it.
          yield* connection.executeRaw("BEGIN IMMEDIATE", [])
          return connection
        })
      }

      get commit() {
        return this.executeRaw("COMMIT", [])
      }

      get rollback() {
        return this.executeRaw("ROLLBACK", [])
      }

      get close() {
        return closeDatabase(this.db)
      }
    }

    const connection = new TursoConnectionImpl(rootDb, true)
    const semaphore = yield* Effect.makeSemaphore(1)

    const withTransaction = Client.makeWithTransaction({
      transactionTag: TursoTransaction,
      spanAttributes,
      acquireConnection: Effect.uninterruptibleMask((restore) =>
        Scope.make().pipe(
          Effect.flatMap((scope) =>
            restore(connection.beginTransaction).pipe(
              Effect.tap((conn) => Scope.addFinalizer(scope, conn.close)),
              Effect.map((conn) => [scope, conn] as const),
              Effect.tapError(() => Scope.close(scope, Exit.void)),
            ),
          ),
        ),
      ),
      begin: () => Effect.void,
      savepoint: (conn, id) =>
        conn.executeRaw(`SAVEPOINT effect_sql_${id};`, []),
      commit: (conn) => conn.commit,
      rollback: (conn) => conn.rollback,
      rollbackSavepoint: (conn, id) =>
        conn.executeRaw(`ROLLBACK TO SAVEPOINT effect_sql_${id};`, []),
    })

    const acquirer = Effect.flatMap(
      Effect.serviceOption(TursoTransaction),
      Option.match({
        onNone: () =>
          semaphore.withPermits(1)(
            Effect.succeed(connection as TursoConnection),
          ),
        onSome: ([conn]) => Effect.succeed(conn),
      }),
    )

    return Object.assign(
      yield* Client.make({
        acquirer,
        compiler,
        spanAttributes,
      }),
      { withTransaction },
    )
  })

const makeBaseTursoLive = (options?: TursoClientOptions) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const dbPath = yield* DatabasePathConfig
      const normalizedPath = normalizeDatabasePath(dbPath)
      const client = yield* makeClient(
        toTursoDatabasePath(normalizedPath),
        options,
      )

      return Context.make(Client.SqlClient, client)
    }),
  ).pipe(Layer.provide(Reactivity.layer))

export const makeTursoLive = (
  options?: TursoClientOptions,
): Layer.Layer<
  Client.SqlClient | DatabaseConnectionInfo,
  ConfigError | SqlError,
  never
> => makeBaseTursoLive(options).pipe(Layer.provideMerge(ConnectionInfoLayer))

export const TursoLive: Layer.Layer<
  Client.SqlClient | DatabaseConnectionInfo,
  ConfigError | SqlError,
  never
> = makeTursoLive()
