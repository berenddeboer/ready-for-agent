import type { SqlError } from "@effect/sql/SqlError"
import type { Effect } from "effect"

/**
 * Cast a Drizzle query builder to Effect.
 *
 * At runtime `@effect/sql-drizzle` patches QueryPromise/SelectBase so they are
 * real Effects. TypeScript module augmentation does not reliably merge onto
 * Drizzle's class re-exports after builder `Omit` chains, so we cast here.
 */
export const runDrizzle = <A>(
  query: PromiseLike<A>,
): Effect.Effect<A, SqlError> => query as unknown as Effect.Effect<A, SqlError>
