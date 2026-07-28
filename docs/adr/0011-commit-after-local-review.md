# Commit After Local Review

After Review succeeds and before Create PR, the Commit Lifecycle Step creates the local git commit for the Work Item's changes.

Before any native git mutation, Commit continues the Implement Session with the build model for one dedicated publication-copy Agent Turn. That turn authors shared title and body only (no file edits, stage, commit, push, or PR). The harness normalizes a single `Closes #<issue>` reference, bounds lengths, rejects blank or generic placeholder copy, and persists the canonical title and body on the Work Item before `git add` / `git commit`. Operator Retry and process restarts reuse persisted copy rather than generating again. When a commit already exists and copy is absent (in-flight upgrade), Commit seeds copy from the actual head commit message.

The harness then attempts the operation natively: it stages only implementation changes in the isolated worktree (excluding harness-owned diagnostic artifacts such as `.ready-for-agent/`), commits with the canonical title as subject and body as the commit body, and runs `git commit` without bypassing hooks. Success is the postcondition that a commit exists after the Work Item starting commit and intended changes are committed—not process exit alone.

When the native attempt fails or the postcondition is absent, Commit continues the Implement Session as a single repair fallback with bounded native failure diagnostics and the preferred canonical message. After fallback, the same postcondition is re-checked; if the agent rewrote the message for repository policy, the harness re-seeds canonical copy from the actual commit so Create PR stays aligned. Operator Retry re-checks the postcondition before mutating again so indeterminate results do not create duplicate commits.

Commit remains a conditionally agent-using Lifecycle Step (not Agent-free) because copy generation always uses an Agent Turn (unless copy is already persisted or seeded) and fallback may invoke another. Mid-run Step Run telemetry records `copy_generation` during the intentional authoring turn; successful Step Runs record `native` or `agent_fallback` for the commit path.

## Consequences

- Commit remains a first-class Lifecycle Step between Review and Create PR.
- Pre-Commit remains harness-run git validation with an OpenCode fix loop on hook failure; Commit's primary commit path is harness-owned with agent repair only when needed.
- Publication title and body are agent-authored once, persisted on the Work Item, and shared with Create PR.
- Hooks and repository commit-message policy are never bypassed on the native path; agents still own unconventional message repair when policy rejects the authored copy.
