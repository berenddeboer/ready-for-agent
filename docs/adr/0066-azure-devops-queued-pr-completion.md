---
status: accepted
amends:
  - 0061
---

# Azure DevOps queued PR completion is in-flight merge work

Azure DevOps commonly answers a complete request with the pull request still
`active` and `mergeStatus: queued`, then flips to `completed` a moment later.
Treating that body as unknown mergeability or as a rejected mergeable PR made
MERGE_PR fail or revalidate while Azure was actually merging — the same
operator symptom as a bad PAT, with a different cause.

After a complete request, `active` + `queued` is in-flight completion: Merge PR
re-fetches the pull request and waits a bounded interval for `completed`. A
PR that becomes `completed` during that wait is merged and continues to local
cleanup. A PR that stays queued past the wait fails as a retryable Merge PR
Step Run whose message says completion is still queued. `conflicts` still
maps to Merge Conflict Handoff; `rejectedByPolicy` and hard HTTP failures are
unchanged. Watch-time `queued` (merge not yet computed) remains unknown
mergeability.

**Considered options:** returning a Merge Revalidation Outcome immediately so
Watch/Refresh could finish the merge — rejected because it consumes the
three-cycle revalidation budget on in-flight Azure work and still tells the
operator the mergeability changed. Failing as `merge_rejected` — rejected
because the complete request was accepted.
