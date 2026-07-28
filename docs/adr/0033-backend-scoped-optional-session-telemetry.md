# Backend-scoped Session Telemetry is optional

Session Telemetry is an optional typed Agent Backend capability, not part of Agent Turn compatibility. The GraphQL lookup is keyed by Work Item ID so the server can authorize access, use captured backend provenance, and distinguish `AVAILABLE`, `MISSING`, `UNAVAILABLE`, and `UNSUPPORTED`; the response includes the backend label.

OpenCode live-reads Session Telemetry from its SQLite session store. Grok Build live-reads Session Telemetry from on-disk session files under `$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/` (default `GROK_HOME` is `~/.grok`): token and cost totals are summed from `turn_completed` usage rows in `updates.jsonl`, and model/timestamps come from `summary.json`. Cost uses Grok's tick scale (`costUsdTicks` / 10^10 = USD). Missing session directories yield `MISSING`; unreadable or corrupt files yield `UNAVAILABLE`. A backend may still declare Session Telemetry unsupported (for example a future adapter without a durable usage source) without blocking Agent Turns.

Keymaxxer integration is a separate optional typed capability. OpenCode may expose the Keymaxxer tools, while initial Grok Build Agent Turns use ambient `gh`; Harness-owned GitHub operations may still use Keymaxxer, and raw GitHub tokens are never copied into an Agent Turn environment.
