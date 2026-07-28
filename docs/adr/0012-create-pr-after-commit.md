# Create PR After Commit

After Commit succeeds and before Watch PR Status Checks, the Create PR Lifecycle Step ensures an open draft pull request exists for the Work Item branch. The harness attempts the operation natively first: it reuses an existing open PR for the exact Work Item branch when found; otherwise it pushes the branch, creates a draft PR through the harness-owned GitHub service (Issue title, deterministic body with the required closing reference, repository default base), using the harness credential path without exposing raw tokens to an Agent Turn. Success requires resolving the open PR identity and persisting its number on the Work Item.

When native creation or verification fails, Create PR continues the Implement Session as a single repair fallback with bounded diagnostics and the existing Create PR contract (including Keymaxxer or ambient credential guidance for the Agent Turn). After any API/process failure, the harness re-looks up the open PR before invoking the agent so an indeterminate create is not duplicated. After fallback, the same resolve-and-persist postcondition applies. Operator Retry re-checks the postcondition first. Create PR remains a conditionally agent-using Lifecycle Step (not Agent-free). Step Run telemetry records `native` or `agent_fallback`.

## Consequences

- Create PR is a first-class Lifecycle Step between Commit and Watch PR Status Checks.
- Ordinary successful paths use zero Agent Turns; repository-specific policy failures still get at most one repair turn per Step Run.
- Create PR success means a PR was created (or an existing suitable PR was accepted) and its exact GitHub identity was recorded; the later status watch determines completion.
