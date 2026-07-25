# Per-Repository Agent Backend with concurrent Active backends

Status: accepted (supersedes ADR 0032; supersedes the instance-wide single-backend and fleet-wide idle-gate portions of ADR 0035)

Harness Config still selects a **default** Agent Backend (OpenCode by default). Each Repository may optionally override that selection; `null` means inherit the default. New and migrated Repositories leave the override unset. Changing a Repository override is rejected while any Work Item for that Repository is unfinished (including Needs Human, paused, and Waiting for Worker Slot). Changing the harness default is rejected only while unfinished Work Items exist on **inheriting** Repositories (effective selection would change).

Multiple Agent Backends may be Active in one Harness at once. A backend is selected-or-in-use when it is the harness default, any Repository override, or the **captured** backend of any unfinished Work Item. Save and startup hot-activate and inspect every selected-or-in-use backend (no process restart); backends leave the Active set when they leave that set. Agent Backend Unavailable is **per backend**: only Work Item creation and Agent Turns that need that backend are blocked. Recheck Agent Backend targets a backend id; status is reported per backend. Agent Backend Preview remains catalog-only for not-yet-saved picks.

Every Work Item captures its **effective** Agent Backend (Repository override or harness default) at creation as both provenance and **routing authority** for its lifetime: Agent Turns and model resolution for that Work Item use the captured backend’s adapter and backend-scoped prefs (Repository map entry falling back to Harness Config map entry). Shared `maxConcurrentAgentTurns` and `maxConcurrentWorkItems` stay instance-wide. Host preflight and startup inspect the union of the harness default and explicit Repository overrides.

Rejected alternatives: one Active backend with only a “preferred” per-repo label (reintroduces global coupling); materializing the default onto every Repository at create (breaks live inherit); dual-backend drain of unfinished Work Items; re-resolving backend from settings on every turn (fights Session continuity and provenance); harness-wide Unavailable when any selected backend fails.

## Consequences

ADR 0035’s hot-activate-without-restart, Preview catalog, and per-backend remembered model prefs remain. CONTEXT vocabulary moves from a singular Active Agent Backend to a set of Active backends with effective selection per Repository. Flat model columns project the harness default’s prefs on Config and each Repository’s **effective** backend prefs on that row; lifecycle resolution prefers backend-scoped maps keyed by captured or effective backend id.
