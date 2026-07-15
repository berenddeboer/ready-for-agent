---
status: accepted
---

# Hand Off Individual PR Status Checks

Extend Watch PR Status Checks to poll the individual GitHub Check Runs and commit status contexts behind the aggregate rollup. Persist each execution that reaches an explicit green result (`SUCCESS`) or red result (`FAILURE`, `ERROR`, `TIMED_OUT`, `ACTION_REQUIRED`, or `STARTUP_FAILURE`) and whether it has been handed to OpenCode; neutral, skipped, cancelled, stale, and pending results do not trigger a handoff.

Batch every currently unhandled result into one run of the existing Investigate PR Status Checks Lifecycle Step, continuing the Work Item's Implement Session with its GitHub credential. The prompt identifies red checks to diagnose and fix; when the batch contains any green check, it also says that automated reviews may have completed and asks OpenCode to inspect the latest pull-request comments, disregard reviews visibly still in progress, and address worthwhile completed feedback. OpenCode returns `READY_FOR_AGENT_RESULT: PROCESSED` or `READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <reason>`.

## Consequences

- A semantic result marks that batch's checks handled. A timeout, crash, malformed result, or other technical failure leaves them unhandled so Retry presents the same batch again.
- The existing 30-second poll, 60-second no-check grace, aggregate status gate, Mark PR Ready for Review step, and terminal Complete behavior remain unchanged.
- There is no classifier, disposable Session, subagent, persisted review-comment state, persisted pull-request identity, new quiescence window, or new Lifecycle Step.
- Ordinary green checks may cause extra Implement Session runs. This is preferred over classification complexity.
- A review comment that is still in progress when its check is handed off, then becomes final without another green or red check result, may be missed. This risk is accepted to keep the design status-check-only.
