# Merge PR after clanker decision

After Decide PR Merge returns clanker merge, the Work Item advances to Merge PR. The step uses the Repository GitHub token through `GitHubService` GraphQL (not `gh` or OpenCode) to find the open pull request on the Work Item's deterministic branch, revalidate the current head's aggregate checks, and call `mergePullRequest` with squash and `expectedHeadOid`. An already merged PR is a success (idempotent).

When GitHub does not merge because the head changed, checks are no longer green, or mergeability is conflicting or unknown, Merge PR records a handled Merge Revalidation Outcome rather than a failed Step Run. The first three such outcomes for a Work Item return it to Watch PR Status Checks with prior individual-check handoff history intact. The Work Item then traverses the normal Watch → Mark PR Ready for Review → Decide PR Merge → Merge PR path again, including a fresh risk decision. Watch uses the existing Resolve PR Merge Conflict and Investigate PR Status Checks handoffs when current evidence requires OpenCode work; Merge PR does not invent a generic repair prompt and OpenCode does not merge.

The fourth Merge Revalidation Outcome moves the Work Item to Needs Human. A rejected merge whose PR remains open, green, mergeable, and at the same head also moves directly to Needs Human because policy or required human action, rather than repairable code state, is blocking it. A concurrently closed PR uses the same merge-related human-outcome path. Credential, transport, malformed-response, and other operational GitHub failures remain failed Merge PR Step Runs eligible for explicit Retry. When Decide PR Merge returns needs-human (including Auto-merge disabled), Merge PR does not run; all merge-related human outcomes are reconciled by Refresh + local cleanup (ADR 0020).

## Consequences

- The clanker path still squash-merges via the harness after a clanker merge decision.
- State races consume a durable three-cycle automatic recovery budget; the budget counts all Merge Revalidation Outcomes for the Work Item and does not reset after an OpenCode repair.
- A handled Merge Revalidation Outcome produces a succeeded Merge PR Step Run even though no merge occurred, preserving the rule that failed Step Runs stay pending for Retry.
- Human-merge Complete may have no Merge PR Step Run or may follow one or more handled Merge PR Step Runs (ADR 0020).
- Merge stays deterministic and Keymaxxer-injected like Mark PR Ready for Review; OpenCode only decides, it does not merge.
- Repository credentials need Contents write (and Pull requests write) so the merge mutation can succeed.
