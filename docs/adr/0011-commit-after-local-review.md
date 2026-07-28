# Commit After Local Review

After Review succeeds and before Create PR, the Commit Lifecycle Step creates the local git commit for the Work Item's changes. The harness attempts the operation natively first: it stages only implementation changes in the isolated worktree (excluding harness-owned diagnostic artifacts such as `.ready-for-agent/`), builds a deterministic commit message from the Issue identity and title with GitHub closing semantics, and runs `git commit` without bypassing hooks. Success is the postcondition that a commit exists after the Work Item starting commit and intended changes are committed—not process exit alone.

When the native attempt fails or the postcondition is absent, Commit continues the Implement Session as a single repair fallback with bounded native failure diagnostics and the existing Commit contract. After fallback, the same postcondition is re-checked. Operator Retry re-checks the postcondition before mutating again so indeterminate results do not create duplicate commits. Commit remains a conditionally agent-using Lifecycle Step (not Agent-free) because fallback may invoke an Agent Turn; a successful native path must not acquire an Agent Turn permit or append to the Work Item Session. Step Run telemetry records `native` or `agent_fallback`.

## Consequences

- Commit remains a first-class Lifecycle Step between Review and Create PR.
- Pre-Commit remains harness-run git validation with an OpenCode fix loop on hook failure; Commit's primary path is harness-owned git commit with agent repair only when needed.
- Hooks and repository commit-message policy are never bypassed on the native path; agents still own unconventional message repair when policy rejects the deterministic template.
