---
status: accepted
amends:
  - 0075
---

# Observe a failed-job retry before a CI Repair concludes

A CI Repair that only names jobs in a No-Change Outcome does not learn whether the failure was transient. The implement prompt used to forbid reruns, so the agent waited until Assess Changes, the harness replayed the whole workflow, and a still-running run rejected the call. The work item failed without the GitHub status or reason, and a later attempt was never observed.

During Implement the agent may request one bounded retry of an observed failing GitHub run. The harness calls GitHub's failed-jobs rerun endpoint, not the whole-workflow endpoint. This is not authorization to replay migrations manually against shared databases.

The Work Item retains the request while sibling jobs are running. Before dispatch, the harness re-reads the run and adopts an already-started replacement, including after restart. It records dispatch intent before calling GitHub so that an interrupted or ambiguous dispatch cannot automatically send a duplicate. After six hours, one final read can recover a completed replacement, but the harness does not dispatch or schedule another poll. If a GitHub cooldown extends beyond the deadline, the harness wakes at the deadline and times out if still throttled, without bypassing the cooldown. Explicit rejections expose the HTTP status and actionable details.

If a crash or lost response makes dispatch unknowable, the harness does not resend. It adopts a replacement if one becomes visible; otherwise it reports that dispatch could not be confirmed at the deadline. A recorded GitHub acknowledgement is distinguished from this case, but is still not a successful repair.

The same repair session sees the terminal replacement result. If the worker restarts after saving that result, Implement resumes the same session with the saved evidence rather than dispatching again. A green result can lead to a No-Change Outcome through normal change assessment. A non-green result includes failed-job details pinned to the observed attempt. Assess Changes and Commit do not dispatch retries.

GitLab and Azure DevOps can still receive code-based CI Repair; harness-mediated retries on those forges are deferred until the replacement can be observed.
