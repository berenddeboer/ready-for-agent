# Review times out on no completed-checkpoint progress, not aggregate duration

Review's one-hour aggregate maximum duration stopped productive multi-round Review after earlier successful reviewing and fix passes had already consumed the budget. Review now uses that same 60-minute value as a no-progress interval: elapsed productive time since the last Review Progress Checkpoint (or Step Run start), excluding Agent Turn admission waiting accrued since that origin. Other Lifecycle Steps keep an aggregate maximum duration.

A checkpoint is only an accepted reviewing verdict or a worktree-changing apply whose required nested Pre-Commit succeeded. The six Review Fix Round limit remains the independent convergence guard; checkpoints do not reset it or add an overall wall-clock ceiling. Timeout stays the existing `timeout` reason, with an operator message that names the last checkpoint or that none completed.

Rejected alternatives were treating tool activity as progress (indefinite busy loops), raising or resetting the round limit (weaker handoff), splitting Review into separate Lifecycle Steps (extra operator surface), and adding a new overall spending ceiling in this change (a possible follow-up, not a replacement for the old cutoff).
