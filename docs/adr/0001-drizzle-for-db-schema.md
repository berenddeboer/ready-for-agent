# Drizzle for schema and migrations on Turso

The local bookkeeping DB is Turso (SQLite). We define tables and migrations with Drizzle **1.0 RC** in `@ready-for-agent/db-schema` (schema + migrations only; no connection or queries). Chosen over Prisma (heavier, weaker fit with Effect), hand-rolled SQL, and Effect Schema alone — typed schema, mature SQLite/Turso support, and a clear split from a future DB client package. RC (not 0.x) for the v3 migration folder layout and casing API.
