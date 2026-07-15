# Decide PR Merge after ready for review

After Mark PR Ready for Review succeeds, the Work Item advances to Decide PR Merge instead of completing immediately. The step continues the Implement OpenCode Session (with the Repository GitHub credential) and asks for a risk-based decision: whether a clanker may merge the PR or a human must. OpenCode reports `READY_FOR_AGENT_RESULT: CLANKER_MERGE` or `READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <reason>`. Clanker-merge completes the Work Item; needs-human is terminal Needs Human. The step does not merge the pull request.

## Consequences

- Complete means the PR is ready for review and assessed as low enough risk for a clanker, not that the PR was merged.
- High-risk PRs surface as Needs Human with OpenCode's reason rather than silent completion.
- Actual clanker merge remains a separate future step.
