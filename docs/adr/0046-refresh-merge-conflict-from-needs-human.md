# Refresh observes merge conflicts while Needs Human awaits human merge

Refresh already completes any Needs Human that owns a merged Work Item PR and Abandons Decide/Merge Needs Human on closed-unmerged (ADR 0020, ADR 0039). It did not inspect mergeability while parked, so a base-branch advance that conflicts a PR waiting for human merge left the card stuck in Attention until a human fixed or merged it. Refresh now also reads mergeability for those handoffs: Decide PR Merge or Merge PR Needs Human with an open conflicting PR advances to Resolve PR Merge Conflict (`refresh_observed_merge_conflict`); Resolve Needs Human whose open PR is no longer conflicting advances to Watch PR Status Checks (`refresh_observed_merge_conflict_cleared`) so settle and merge decision run again; still-conflicting Resolve Needs Human stays parked to avoid thrashing the Implement Session; unknown mergeability is a no-op. Closed-unmerged Abandon eligibility widens to Resolve Needs Human. Discovery stays Refresh-only—no dedicated Needs Human PR poll loop. No new Lifecycle Step; two new transitions from `needs_human` with reason `native`.

## Consequences

- Extends ADR 0020; does not replace Watch/Mark Ready conflict detection (ADR 0018).
- Closed-unmerged Abandon is no longer limited to Decide/Merge Needs Human (updates ADR 0039 wording).
- Operator Retry remains unavailable for conflict Needs Human; clearance is Refresh-driven when mergeability recovers.
