# Decide PR Merge after ready for review

After a settled ready PR, Classify and `off` advance to Decide PR Merge instead of completing immediately; effective Always skips this step and advances to Merge PR (ADR 0059). When Decide PR Merge runs, the step continues the Implement OpenCode Session (with the Repository GitHub credential) and asks for a risk-based decision: whether a clanker may merge the PR or a human must. OpenCode reports `READY_FOR_AGENT_RESULT: CLANKER_MERGE` or `READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <reason>`. Clanker-merge advances to Merge PR (ADR 0017); needs-human is Needs Human without merging. A later Refresh Job may resume that handoff when the PR is merged or closed unmerged (ADR 0020). The step does not merge the pull request.

An operator may also explicitly Resume a Decide PR Merge Needs Human handoff, including an already-persisted generic `needs_human` record whose latest succeeded Step Run has a null reason. Resume re-enters Decide PR Merge in the same session and asks the agent to reconcile the operator's clarification. Chatting in the session does not start that step and is not merge authorization. A previous interactive `CLANKER_MERGE` marker is ignored; only the fresh managed turn's final result line is read, and an approval still enters the normal Merge PR path. If the assessment is still unresolved, the Work Item stays a resumable Needs Human handoff. Resume is not a Merge Policy override: `off` still parks for a human merge. This Resume is distinct from Decision needed Resume, which returns to Implement.

## Consequences

- High-risk PRs surface as Needs Human with OpenCode's reason rather than silent completion.
- Effective Merge Policy `off` short-circuits to Needs Human without calling OpenCode.
- Effective Always never runs this step or its risk Agent Turn.
- Actual harness merge is a separate Merge PR step after clanker approval or an Always skip of Decide (ADR 0059); human merge is detected on Refresh (ADR 0020).
- Explicit Resume continues a merge-assessment handoff at Decide PR Merge. It does not restart Implement, recreate the PR, or treat session chat as authorization.
