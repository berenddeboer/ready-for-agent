# Fail fast when the binary is older than the database's applied migrations

`runConfiguredMigrations` (`@ready-for-agent/db`) now detects stale-binary
drift before applying anything: after ensuring `__drizzle_migrations` exists,
it compares the hashes already recorded there against the hashes of this
binary's embedded/on-disk migration set. Migration identity is content-hash
based (see `applyMigrationRecords`), so any row recorded in the database whose
hash isn't in the binary's known set means the database was migrated by a
*newer* build than the one currently running — the common failure mode from a
stale globally-installed CLI pointed at a database a local dev build (or a
newer release) already migrated (ready-for-agent#18). In that case the runner
fails with a typed `StaleBinaryMigrationError` naming the unrecognized
migrations instead of silently skipping them and proceeding, which previously
left a stale binary querying columns/tables it doesn't know about — surfacing
as an infinite `Polling Auto-heal Job failed` / `Issue polling job queue poll
failed` retry loop rather than a clear error. Because this check runs inside
`applyMigrations`, which `startProductionLifecycle` awaits before creating the
Effect `Scope`, spawning the Keymaxxer Sidecar, or starting the application/job
worker (ADR 0045), the failure aborts startup immediately with no retry loop
and no partially-started child processes to clean up. When the binary is at
least as new as the database (the common case), every recorded hash is
recognized and startup proceeds exactly as before.

This detection assumes migration history is append-only and content-hash
identity is stable once a migration is merged (migration files are never
edited after being shipped). The one historical exception is the migration
squash in commit `231baf1`: the runner explicitly recognizes the exact hashes
of the 23 migrations retired by that squash because upgraded databases retain
those rows after adopting the replacement baseline. Any other unrecognized
recorded hash means the database saw a later migration than this binary knows
about, matching the "stale binary" diagnosis the message gives. The remedy it
suggests (upgrade/reinstall, or point at a fresh database) stays correct advice
even in the atypical case of two divergent branches sharing one local database,
so the fail-fast behavior is safe either way even where the exact wording of
the diagnosis might not fit.
