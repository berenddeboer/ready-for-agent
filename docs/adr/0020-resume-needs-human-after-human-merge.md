# Resume merge-related Needs Human after human PR outcome

Needs Human after Decide PR Merge or Merge PR stays non-advancing for ordinary lifecycle operations, but a successful Refresh Job (manual or scheduled Issue Polling) inspects that Work Item's PR. Merged → clear the handoff reason, advance to local cleanup only, then Complete. Closed unmerged → Abandon only after local cleanup succeeds; cleanup failure leaves Needs Human. Other Needs Human causes are not auto-resumed. Needs Human blocks a second Implement Now for the same Issue; operator Abandon is allowed from Needs Human with the same cleanup-before-Abandoned rule. Complete means the Work Item PR is merged and local cleanup finished, whether merge was performed by the harness or a human.

## Consequences

- Refresh is the only automatic exit from merge-related Needs Human; there is no dedicated PR poll loop while Needs Human.
- A human-merge path from Decide PR Merge has no Merge PR Step Run; one from Merge PR retains its handled merge attempts.
- Abandon from Needs Human (operator or closed-PR Refresh) requires successful local cleanup first.
