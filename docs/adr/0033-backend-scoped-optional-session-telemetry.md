# Backend-scoped Session Telemetry is optional

Session Telemetry is an optional typed Agent Backend capability, not part of Agent Turn compatibility. The GraphQL lookup is keyed by Work Item ID so the server can authorize access, use captured backend provenance, and distinguish `AVAILABLE`, `MISSING`, `UNAVAILABLE`, and `UNSUPPORTED`; the response includes the backend label. OpenCode may continue to live-read its SQLite data, while initial Grok Build support reports telemetry as unsupported rather than duplicating per-turn usage or blocking the backend.

Keymaxxer integration is a separate optional typed capability. OpenCode may expose the Keymaxxer tools, while initial Grok Build Agent Turns use ambient `gh`; Harness-owned GitHub operations may still use Keymaxxer, and raw GitHub tokens are never copied into an Agent Turn environment.
