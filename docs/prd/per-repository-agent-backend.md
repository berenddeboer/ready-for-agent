# Per-Repository Agent Backend selection

> Spec ready for GitHub issue with label `ready-for-agent`.
> Domain: `CONTEXT.md`, ADR 0037 (supersedes instance-wide portions of 0035).
> Historical scope note: ADR 0052 later adds the deliberately separate Implement With path; the ordinary per-Repository behavior specified here remains unchanged.

## Problem Statement

Operators can only choose one Agent Backend for the entire Harness instance. Teams that work multiple Repositories often want different backends per repo (for example OpenCode on one codebase and Grok Build on another). Today that requires changing the global setting and waiting until every unfinished Work Item anywhere is gone, and it never allows two backends to run at once.

## Solution

Keep a Harness-wide **default** Agent Backend, and let each Repository optionally **override** it (or inherit the default). Multiple backends may be Active concurrently. Changing a repo’s backend is blocked only while that repo has unfinished Work Items; changing the global default is blocked only while unfinished Work Items inherit the default. Health, recheck, create, and Agent Turns are scoped to the backend that work actually needs.

Domain and decision records: `CONTEXT.md`, ADR 0037 (supersedes instance-wide single-backend / fleet-wide idle gate in 0035).

## User Stories

1. As an operator, I want to set a default Agent Backend in Harness Config, so that new and unset Repositories share a sensible default without per-repo ceremony.
2. As an operator, I want a Repository to inherit the harness default when I do not override the backend, so that one change to the default updates every inheriting Repository.
3. As an operator, I want to override the Agent Backend on a single Repository, so that that codebase can use a different CLI without affecting others.
4. As an operator, I want to clear a Repository backend override back to “Harness default”, so that the repo follows the global selection again.
5. As an operator, I want new Repositories to start with no backend override, so that they inherit the current default automatically.
6. As an operator migrating an existing database, I want existing Repositories to keep inheriting the global backend, so that behavior does not change until I opt in per repo.
7. As an operator, I want to run Work Items on two Repositories with different backends at the same time, so that I do not serialize all agent work on one CLI brand.
8. As an operator, I want unfinished Work Items (including Needs Human, paused, and Waiting for Worker Slot) on a Repository to block changing that Repository’s backend, so that Sessions and captured routing stay coherent.
9. As an operator, I want unfinished Work Items on Repositories with an explicit override not to block changing the harness default, so that I can retarget the default while other repos are busy on their overrides.
10. As an operator, I want unfinished Work Items on inheriting Repositories to block changing the harness default, so that in-flight inherited work is not retargeted underneath them.
11. As an operator, I want terminal Work Items (Complete, Failed, Abandoned) not to block backend changes, so that finished history does not freeze settings.
12. As an operator, I want Save of an allowed backend change to hot-activate the backend immediately without restarting the Harness, so that I can keep working in one session.
13. As an operator, I want a failed hot-activation to mark that backend Unavailable without undoing the saved selection, so that I can fix the CLI and Recheck without Selected≠Active limbo.
14. As an operator, I want Agent Backend Preview of a not-yet-saved backend’s model catalog in Settings and Repository settings, so that I can pick models before Save.
15. As an operator, I want Preview not to run Agent Turns on the previewed backend, so that draft UI never routes live work.
16. As an operator, I want per-backend readiness status in the UI, so that I can see which Active backends are Ready or Unavailable.
17. As an operator, I want Recheck Agent Backend for a specific backend id, so that I can recover one broken backend without implying a global outage.
18. As an operator, I want optional recheck-all for selected-or-in-use backends, so that I can refresh health after a machine change.
19. As an operator, I want Work Item creation on a healthy override Repository to succeed even if the harness default backend is Unavailable or unconfigured, so that one broken default does not freeze the fleet.
20. As an operator, I want Implement Now to fail clearly when the Repository’s effective backend is Unavailable, so that I know which CLI to fix.
21. As an operator, I want Implement Now to fail with “Select a default build model first” when no build model resolves for the effective backend, so that first-run guidance stays accurate per backend.
22. As an operator, I want a first-run banner when the harness default backend has no build model, without hard-blocking override Repositories that are fully configured, so that setup guidance stays useful without false globals.
23. As an operator, I want a new Work Item to capture the effective Agent Backend at creation, so that provenance and routing are fixed for that attempt.
24. As an operator, I want all Agent Turns on a Work Item to use the captured backend’s adapter, so that Session IDs never cross backends.
25. As an operator, I want model resolution for a Work Item to use backend-scoped prefs for the captured backend (Repository then Harness), so that dual-backend fleets do not clobber each other’s models.
26. As an operator, I want Repository settings model fields to read and write prefs for that Repository’s effective backend, so that the dialog matches the backend I selected for the repo.
27. As an operator, I want Harness Config model fields to continue mirroring the default backend’s prefs, so that global Settings stay coherent.
28. As an operator, I want backend-scoped model prefs remembered when I switch backends, so that returning to a backend restores prior build/review picks.
29. As an operator, I want shared max concurrent Agent Turns and Work Items across backends, so that machine load stays bounded regardless of how many backends are Active.
30. As an operator, I want backends that are no longer the default, any override, or an unfinished Work Item’s capture to leave the Active set, so that status and runtime only track what is needed.
31. As an operator, I want startup and host preflight to consider the harness default plus every distinct Repository override, so that missing CLIs for selected backends surface early without requiring unused adapters.
32. As an operator, I want unfinished Work Items’ captured backends to stay Active even when the global default rotates (while those WIs use explicit overrides), so that mid-ship work continues.
33. As an operator, I want the Repository settings dialog to offer “Harness default (…)” plus selectable backends, so that inherit vs override is obvious.
34. As an operator, I want the backend control above model fields in Repository settings, so that catalog and prefs stay consistent with the draft selection.
35. As an operator, I want a clear disabled reason when a backend change is blocked (scoped unfinished counts), so that I know whether to finish work on this repo or on inheriting repos.
36. As an operator, I want global Settings to keep the default backend selector, multi-backend health, and recheck controls, so that instance defaults stay in one place.
37. As an operator, I want Work Item detail and history to show the captured backend, so that I can see which CLI produced the work.
38. As an operator, I want Agent-free Lifecycle Steps to keep running when a backend is Unavailable, so that non-agent maintenance continues.
39. As an operator, I want steps that may invoke an agent not to start while that Work Item’s captured backend is Unavailable, so that conditional agent steps fail safe.
40. As an operator, I want runtime Agent Turn failures to fail only the Step Run, not mark the whole Harness dead, so that other work continues.
41. As an operator, I want the Harness never to silently fall back to another backend on failure, so that routing stays explicit.
42. As an operator, I want coordination between settings Save and Work Item creation, so that Implement Now cannot capture a pre-activate backend during a concurrent Save.
43. As an operator, I want GraphQL to expose nullable Repository backend override, effective selection (or enough fields to derive it), scoped gate counts, and multi-backend status, so that the UI can implement the product without private APIs.
44. As an operator, I want invalid backend ids rejected on config and repository settings, so that bad data cannot enter the store.
45. As an operator, I want same-backend Saves to skip full re-inspect (Recheck remains explicit), so that ordinary model-only Saves stay fast.
46. As a developer, I want CONTEXT and ADRs to describe multi-backend and per-repo selection, so that future changes do not reintroduce a single global Active backend by accident.

## Implementation Decisions

- **ADR / domain**: Implement against ADR 0037 and updated `CONTEXT.md`. Keep ADR 0035 hot-activate, Preview, and per-backend model prefs; do not keep single-backend or fleet-wide idle gate.
- **Schema**: Add nullable Repository Agent Backend override (null = inherit). Migrate existing rows to null. Harness Config retains default `selectedAgentBackend`.
- **Effective selection**: `repository.override ?? config.default`.
- **Gates**: Unfinished = non-terminal (includes Needs Human, paused, Waiting for Worker Slot). Repo override change: any unfinished WI on that repo. Global default change: unfinished WIs only on inheriting repos. Errors carry **blocking** count and scope (global vs repository). Keep total unfinished count if still useful for fleet visibility; do not overload it as the gate.
- **Selected-or-in-use**: harness default ∪ distinct repo overrides ∪ unfinished WIs’ captured backends. Activate/inspect on Save and startup for that set; drop backends that leave the set.
- **Unavailable**: per backend. Create and agent gates use effective (create) or captured (turns) backend only.
- **Capture + route**: Work Item creation captures effective backend under the same coordination used today for config activate vs create. Agent Turns and Session ops route by captured backend id for the WI lifetime. Do not re-resolve backend from settings each turn.
- **Models**: Write Repository model settings into `backendModelPrefs[effectiveBackend]`. Resolve turn models from repo map then harness map for **captured** backend. Config flat columns mirror default backend; Repository flat columns project that row’s effective backend. Lifecycle must not assume a single global Active for prefs.
- **Active multi-registry**: Replace singular Active Agent Backend runtime with a multi-backend registry (status list, activate, recheck by id, get adapter/telemetry by backend id). Process-wide turn proxy must dispatch by backend id, not a single Active slot.
- **API**: Repository settings mutation accepts optional backend override (including clear-to-null). Config mutation keeps default backend with scoped gate. Status becomes a list (or equivalent) by backend id; `recheckAgentBackend` takes backend id. Expose scoped blocking counts for UI copy.
- **UI**: Repository settings: backend select with “Harness default (label)”, above models; Preview when draft backend differs; disable Save/change with scoped reason. Global Settings: default backend, multi health, recheck by id, scoped gate for default. First-run banner tied to default backend build model, not a hard global freeze of configured overrides.
- **Host preflight**: Peek union of config default and distinct non-null repository overrides; check host tools for those backends.
- **Concurrency**: Keep instance-wide `maxConcurrentAgentTurns` and `maxConcurrentWorkItems`.
- **Docs already landed with this ticket’s prep**: ADR 0037, ADR 0035 status updates, `CONTEXT.md` vocabulary — implementers should align code to those, not re-litigate product.

## Testing Decisions

**What makes a good test**: Assert operator-visible and service-boundary behavior (gates, effective/capture, status, routing, prefs keying). Avoid locking internal file layout or private helpers. Prefer highest existing seams.

**Seams**

1. **DbService (primary for persistence rules)** — gates, nullable override, prefs keying, blocking counts/errors, migration inherit-null. Prior art: existing config backend-change and repository settings specs.
2. **GraphQL API (primary product acceptance)** — mutations/queries for override, multi status, recheck(backendId), scoped counts, activate coordination on Save, create blocked by effective backend. Prior art: graphql-api config/status tests.
3. **Active Agent Backend multi-registry** — concurrent Active, drop when unused, per-backend status/recheck/Unavailable, dispatch by id. Prior art: active-agent-backend specs.
4. **Work Item Lifecycle** — capture effective at create; turns/readiness/models use captured backend. Prior art: agent-backend-readiness and implement-now paths.
5. **Host preflight (thin)** — union of default ∪ overrides. Prior art: host-tools-preflight / peek tests.
6. **Harness UI (thin smoke)** — repo backend control + global multi-status/gate copy. Prior art: harness-settings-backend-change source smoke.

Not required for acceptance: full dual-backend Playwright e2e (optional later).

## Out of Scope

- Third-party or operator-defined Agent Backend plugins
- Per-Work-Item backend selection independent of Repository effective selection (superseded for the distinct Implement With path by ADR 0052)
- Dual-backend routing mid-flight on a single unfinished Work Item (changing backend under an unfinished WI)
- Per-backend concurrency limits
- Snapshotting build/review models onto Work Items (superseded only for ADR 0052's complete Explicit Work Item Execution Profile; ordinary Work Items remain settings-resolved)
- Requiring all built-in CLIs installed when unused
- Automatic silent fallback between backends
- Materializing the default onto every Repository at create (no live inherit)
- Changing triage/lifecycle product behavior unrelated to backend selection

## Further Notes

- Domain language: prefer **Effective Agent Backend**, **Active Agent Backend** (set), **captured** backend on Work Item; avoid “instance-wide only backend.”
- Implementation will necessarily touch ActiveAgentBackend shape, DbService update paths that currently key repo prefs off global selected backend, GraphQL schema, harness settings UI, and host peek/preflight.
- When implementing, run relevant `bunx nx` test targets for db-service, graphql-api, agent-backend, work-item-lifecycle, and harness as affected.
