# Decide PR Merge after ready for review

After a settled ready PR, Classify and `off` advance to Decide PR Merge instead of completing immediately; effective Always skips this step and advances to Merge PR (ADR 0059). When Decide PR Merge runs, the step continues the Implement OpenCode Session (with the Repository GitHub credential) and asks for a risk-based decision: whether a clanker may merge the PR or a human must. OpenCode reports `READY_FOR_AGENT_RESULT: CLANKER_MERGE` or `READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <reason>`. Clanker-merge advances to Merge PR (ADR 0017); needs-human is Needs Human without merging. A later Refresh Job may resume that handoff when the PR is merged or closed unmerged (ADR 0020). The step does not merge the pull request.

## Consequences

- High-risk PRs surface as Needs Human with OpenCode's reason rather than silent completion.
- Effective Merge Policy `off` short-circuits to Needs Human without calling OpenCode.
- Effective Always never runs this step or its risk Agent Turn.
- Actual harness merge is a separate Merge PR step after clanker approval or an Always skip of Decide (ADR 0059); human merge is detected on Refresh (ADR 0020).
