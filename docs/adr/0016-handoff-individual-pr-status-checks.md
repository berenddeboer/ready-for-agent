---
status: accepted
---

# Hand Off Individual PR Status Checks

Extend Watch PR Status Checks to poll the individual CheckRun and StatusContext entries behind the aggregate GraphQL status-check rollup. Persist each observed CheckRun execution and StatusContext that reaches an explicit green result (`SUCCESS`) or red result (`FAILURE`, `ERROR`, `TIMED_OUT`, `ACTION_REQUIRED`, or `STARTUP_FAILURE`) and whether it has been handed to OpenCode; neutral, skipped, cancelled, stale, and pending results do not trigger a handoff.

Batch every currently unhandled result into one run of the existing Investigate PR Status Checks Lifecycle Step, continuing the Work Item's Implement Session with its GitHub credential. Before turn (1), the harness loads diagnostics for red checks (Actions job logs for `actions-job:<id>`; Checks 403 is expected for fine-grained PATs). Investigation is two OpenCode turns on that Session: (1) address red checks (named by external id, with harness log artifacts when present) / worthwhile completed review feedback, commit and push, without a result marker; (2) a short follow-up that only asks for one of `READY_FOR_AGENT_RESULT: PROCESSED`, `READY_FOR_AGENT_RESULT: FAILED: <reason>`, or `READY_FOR_AGENT_RESULT: NEEDS_HUMAN: <reason>`. When the batch contains any green check, turn (1) also says that automated reviews may have completed and asks OpenCode to inspect the latest pull-request comments, disregard reviews visibly still in progress, and address worthwhile completed feedback. Turn (1) tells OpenCode to restart transient infrastructure failures when appropriate before concluding. Failure to load diagnostics is a failed Step Run (Retry-eligible), not Needs Human by itself.

`PROCESSED` means OpenCode took an action expected to produce new check executions (push a fix, restart failed checks, or similar), or the handoff was green-only review feedback with nothing to address. When a handoff contains red checks and OpenCode makes no commit, push, check restart, or other action capable of producing a new execution, leaving the PR red, OpenCode must report `FAILED` with a concise reason. That outcome marks the batch handled, keeps the Investigate Step Run successful (protocol completed), and transitions the Work Item atomically to terminal `failed` with failure code `pr_status_checks_unresolved` and OpenCode's reason as the failure message, releasing the Worker Slot and enqueuing no further poll. `FAILED` is not Needs Human and is not a retryable failed Step Run. Genuine human decisions still use `NEEDS_HUMAN`.

## Consequences

- A semantic result (`PROCESSED`, `FAILED`, or `NEEDS_HUMAN`) marks that batch's checks handled. A timeout, crash, malformed result, diagnostics load failure, or other technical failure leaves them unhandled so Retry presents the same batch again.
- After `PROCESSED`, Watch continues polling so replacement executions can appear. After `FAILED`, the Work Item is terminal and does not poll again.
- The existing 30-second poll, 60-second no-check grace, aggregate status gate, Mark PR Ready for Review step, and terminal Complete behavior remain unchanged for successful paths.
- There is no classifier, disposable Session, subagent, persisted review-comment state, persisted pull-request identity, new quiescence window, or new Lifecycle Step.
- Ordinary green checks may cause extra Implement Session runs. This is preferred over classification complexity.
- A review comment that is still in progress when its check is handed off, then becomes final without another green or red check result, may be missed. This risk is accepted to keep the design status-check-only.
