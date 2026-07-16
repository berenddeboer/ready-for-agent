# Resume Decide PR Merge Needs Human after human PR outcome

Needs Human after Decide PR Merge stays non-advancing for ordinary lifecycle operations, but a successful Refresh Job (manual or scheduled Issue Polling) inspects that Work Item's PR. Merged → clear the handoff reason, advance to local cleanup only (no Merge PR Step Run), then Complete. Closed unmerged → Abandon only after local cleanup succeeds; cleanup failure leaves Needs Human. Other Needs Human causes are not auto-resumed. Needs Human blocks a second Implement Now for the same Issue; operator Abandon is allowed from Needs Human with the same cleanup-before-Abandoned rule. Complete means the Work Item PR is merged and local cleanup finished, whether merge was harness Merge PR or human.

## Consequences

- Refresh is the only automatic exit from Decide PR Merge Needs Human; there is no dedicated PR poll loop while Needs Human.
- Step history for the human-merge path has no Merge PR Step Run.
- Abandon from Needs Human (operator or closed-PR Refresh) requires successful local cleanup first.
