# Session usage via live OpenCode SQLite

The Jobs Completed dialog needs OpenCode session model, token totals (input, output, reasoning, cache read/write), cost, and timestamps. We expose that with a root GraphQL `session(id: String!)` query that live-reads OpenCode’s SQLite (`opencode db path` / XDG data dir), not a harness-side snapshot and not `opencode export`.

**Why live-read, not snapshot:** usage is already authoritative in OpenCode; duplicating it on every start/continue couples the lifecycle to NDJSON parsing and still goes stale if OpenCode is the source of truth mid-session. Completed history accepts “missing if OpenCode pruned the row.”

**Why SQLite, not export:** export returns the full transcript and is too heavy for a totals dialog; the `session` table already has the aggregates.

**API shape:** `session` returns null when no Work Item owns that `sessionId` (do not leak unrelated local chats). When owned, return a `Session` with `availability` `AVAILABLE` | `MISSING` | `UNAVAILABLE` so the dialog can open with Suspense/error UI when the row is gone or the DB is locked. OpenCode metric fields are null unless `AVAILABLE`. No agent field; no Work Item chrome on the payload (the Completed row already shows it).

**Access:** read-only SQLite with a short timeout; lock/read failures map to `UNAVAILABLE`. Path resolution follows OpenCode’s data directory rules only—no harness override.
