# Prefixed ULID entity IDs

Primary keys are **type-prefixed ULIDs**: `{prefix}-{ulid}` (e.g. `qjob-01H…`, `cj-01H…`). The prefix is a short stable type code (Xplain-style), not a display label. Bare ULIDs on early tables (e.g. `repository`) are legacy; new tables use prefixes, and existing tables may migrate when convenient.

**Why:** IDs stay sortable/unique like plain ULIDs, but logs, FKs, and queue payloads are self-describing (no “what table is this id from?”). Rejected alternatives: bare ULID everywhere (cheaper, harder to debug); UUID v4 (no sort); integer PKs (Turso/distributed-unfriendly).

**TypeScript brands** (e.g. `Schema.brand("JobId")`) are optional at call sites; the **stored** form is always the prefixed string.
