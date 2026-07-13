import * as SqliteDrizzle from "@effect/sql-drizzle/Sqlite"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import { Context, Effect, Layer } from "effect"
import * as schema from "@ready-for-agent/db-schema"

type TypedSqliteDatabase = SqliteRemoteDatabase<typeof schema>
type SqliteDrizzleConfig = Parameters<
  typeof SqliteDrizzle.make<typeof schema>
>[0]

// @effect/sql-drizzle types lag Drizzle v1 schema generics slightly
const sqliteDrizzleConfig = { schema } as SqliteDrizzleConfig

/**
 * Tag for typed Drizzle ORM database service over the harness schema.
 */
export class TypedSqliteDrizzle extends Context.Tag(
  "@ready-for-agent/db/TypedSqliteDrizzle",
)<TypedSqliteDrizzle, TypedSqliteDatabase>() {}

/**
 * Layer that provides TypedSqliteDrizzle.
 * Requires a SQL client (SqliteClient / LibsqlClient) in the environment.
 */
export const TypedSqliteDrizzleLayer = Layer.effect(
  TypedSqliteDrizzle,
  SqliteDrizzle.make<typeof schema>(sqliteDrizzleConfig).pipe(
    Effect.map((db) => db as unknown as TypedSqliteDatabase),
  ),
)
