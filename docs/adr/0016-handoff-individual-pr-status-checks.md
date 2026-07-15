---
status: accepted
---

# Hand Off Individual PR Status Checks

Extend Watch PR Status Checks to poll the individual GitHub Actions jobs and classic commit statuses behind the aggregate rollup (via REST; fine-grained PATs cannot read GraphQL CheckRun nodes). Persist each execution that reaches an explicit green result (`SUCCESS`) or red result (`FAILURE`, `ERROR`, `TIMED_OUT`, `ACTION_REQUIRED`, or `STARTUP_FAILURE`) and whether it has been handed to OpenCode; neutral, skipped, cancelled, stale, and pending results do not trigger a handoff.

Batch every currently unhandled result into one run of the existing Investigate PR Status Checks Lifecycle Step, continuing the Work Item's Implement Session with its GitHub credential. Investigation is two OpenCode turns on that Session: (1) address red checks / worthwhile completed review feedback, commit and push, without a result marker; (2) a short follow-up that only asks for `READY_FOR_AGENT_RESULT: PROCESSED` or `READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <reason>`. When the batch contains any green check, turn (1) also says that automated reviews may have completed and asks OpenCode to inspect the latest pull-request comments, disregard reviews visibly still in progress, and address worthwhile completed feedback.

## Consequences

- A semantic result marks that batch's checks handled. A timeout, crash, malformed result, or other technical failure leaves them unhandled so Retry presents the same batch again.
- The existing 30-second poll, 60-second no-check grace, aggregate status gate, Mark PR Ready for Review step, and terminal Complete behavior remain unchanged.
- There is no classifier, disposable Session, subagent, persisted review-comment state, persisted pull-request identity, new quiescence window, or new Lifecycle Step.
- Ordinary green checks may cause extra Implement Session runs. This is preferred over classification complexity.
- A review comment that is still in progress when its check is handed off, then becomes final without another green or red check result, may be missed. This risk is accepted to keep the design status-check-only.
