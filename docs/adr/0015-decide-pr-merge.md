# Decide PR Merge after ready for review

After Mark PR Ready for Review succeeds, the Work Item advances to Decide PR Merge instead of completing immediately. The step continues the Implement OpenCode Session (with the Repository GitHub credential) and asks for a risk-based decision: whether a clanker may merge the PR or a human must. OpenCode reports `READY_FOR_AGENT_RESULT: CLANKER_MERGE` or `READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <reason>`. Clanker-merge advances to Merge PR (ADR 0017); needs-human is Needs Human without merging. A later Refresh Job may resume that handoff when the PR is merged or closed unmerged (ADR 0020). The step does not merge the pull request.

## Consequences

- High-risk PRs surface as Needs Human with OpenCode's reason rather than silent completion.
- Auto-merge disabled short-circuits to Needs Human without calling OpenCode.
- Actual harness merge is a separate Merge PR step after clanker approval; human merge is detected on Refresh (ADR 0020).
