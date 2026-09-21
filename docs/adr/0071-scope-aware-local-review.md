# Scope-Aware Local Review

## Decision

Implement, Review, and review repairs share `.ready-for-agent/scope.md` in
the Work Item worktree. The harness creates an initial handoff and reloads it
into each substantive turn. The agent reconciles it with the Issue and explicit
operator decisions before acting or delegating, recording requirements,
amendments, accepted limitations, and deferred work with source references.
Operator amendments take precedence over conflicting original Issue text;
agent proposals and findings cannot grant themselves scope approval.

The file survives Retry, process restarts, and Session compaction while the
worktree exists. Existing harness-artifact exclusions keep it out of commits
and Review product-change fingerprints. Existing Work Items acquire the handoff
on their next Review. Operators may also edit it directly. Delegated reviewers
receive the reconciled handoff, not merely the original Issue link.

Review Findings must establish a regression introduced by the change or an
unmet agreed requirement, supported by a failing example or a concrete code
path and applicable preconditions. Pre-existing out-of-scope limitations and
speculative hardening are non-blocking follow-up observations and do not
contribute to the result severity. Production incidents are not required as
evidence. A genuine dependency on broader work calls for a scope decision.

The builder may clear findings of any reported severity with a recorded,
evidence-backed rationale: disproven, pre-existing and outside the agreed
scope, or covered by an explicit operator-accepted limitation. Mere
disagreement, uncertainty, or repair cost is not clearance. Valid unresolved
high findings still stop for human attention, and high deferrals are still
rejected. A claimed clearance accompanied by product changes is verified and
reviewed again rather than bypassing checks.

The harness owns full-review scheduling. Build and repair prompts request
focused verification and prohibit nested full-worktree reviews. Existing
Pre-Commit checks, severity-based reruns, and fix-round limits remain in force.

## Trade-offs

This is a local handoff and prompt policy, not another agent phase or database
workflow. Recording decisions and evaluating evidence still depend on agent
judgment. The harness cannot reconstruct operator decisions already lost from
a legacy Session; the operator must restate them or edit the handoff. Reset
removes the handoff with the worktree. It is not a replacement for updating the
Issue when a scope amendment should apply to future Work Items.
