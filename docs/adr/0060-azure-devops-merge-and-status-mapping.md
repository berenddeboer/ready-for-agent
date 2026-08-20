---
status: accepted
amends:
  - 0043
  - 0055
  - 0059
---

# Azure DevOps PR Status Checks, merge, and work item close-out mapping

Azure DevOps joins GitHub and GitLab as a third Forge. This ADR records the
concrete REST mapping for the PR/merge state machine's remaining surface —
`getPullRequestCheckStatus`, `getPrStatusCheckDiagnostics`,
`getPullRequestLifecycleStatus`, `mergePullRequest`,
`ensureIssueCompletedWithSummary`, `closeOpenPullRequestsForBranch`,
`deleteBranch` — since, unlike GitLab's pipeline-job model (ADR 0043), Azure
DevOps has no prior art in this codebase for any of these.

**PR Status Checks combine pull request statuses and branch policy
evaluations.** `getPullRequestCheckStatus` reads both
`GET .../pullrequests/{id}/statuses` (a status's `state` maps
`succeeded`→green, `failed`/`error`→red, anything else stays pending/ignored)
and `GET .../policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{pullRequestId}`
(`approved`→green, `rejected`/`broken`→red, `queued`/`running`→pending,
`notApplicable`→ignored), so build-validation and branch-policy gates are
visible the same way an external CI status is. `mergeStatus` on the pull
request itself (`notSet`/`queued`/`conflicts`/`succeeded`/`rejectedByPolicy`/
`failure`) maps to Watch mergeability: only `conflicts` is a true git
conflict (routes to Merge Conflict Handoff); `rejectedByPolicy` and `failure`
are non-conflict blockers (map to `unknown`, matching GitLab's convention
that policy/CI/approval blockers must not invent a rebase-required conflict).

**Merge and lifecycle observe active-first, falling back to any-status.**
`resolvePullRequestForBranch` prefers the active pull request for a branch and
falls back to the newest pull request in any status, mirroring GitLab's
`resolveMergeRequestIidForBranch` "prefer open, else latest any-state" so
Watch/Merge/Lifecycle can observe a just-completed or just-abandoned pull
request. `mergePullRequest` completes via `PATCH .../pullrequests/{id}` with
`status: "completed"` and `lastMergeSourceCommit: {commitId: <expected head>}`
— Azure DevOps rejects a stale `lastMergeSourceCommit` the same way GitLab's
`sha` merge parameter guards against a concurrent push, so `400`/`409`/`422`
are treated as "handled, re-classify" (mirroring GitLab's `405`/`406`/`409`/
`422`), and any other status code is a hard failure.

**Work item close-out is a `System.State` transition plus a marked comment.**
`ensureIssueCompletedWithSummary` posts a hidden-marker comment via the
preview-versioned comments API (`_apis/wit/workitems/{id}/comments`,
`api-version=7.1-preview.3` — the stable `7.1` surface has no comments
endpoint) before transitioning `System.State`. Because Azure DevOps has no
fixed closed-state name across process templates (Agile/CMMI use "Closed",
Scrum uses "Done"/"Removed"), the transition first looks up the work item
type's `workitemtypes/{type}/states` and writes whichever state has category
`Completed`, falling back to the literal `"Closed"` when that lookup fails
for any reason (network error, unexpected 404, decode failure) or finds no
Completed-category state — matching the existing `CLOSED_STATE_NAMES`
read-side heuristic used to classify Ready Issues' open/closed state.

**Close-out cleanup is two separate calls, matching GitLab's shape.**
`closeOpenPullRequestsForBranch` (`PATCH .../pullrequests/{id}` with
`status: "abandoned"`) and `deleteBranch` (`POST .../refs` with a zero
`newObjectId`, git's null object id) are separate methods, unlike GitHub's
combined `closeOpenPullRequestsAndDeleteBranch` — Azure DevOps's REST surface
does not offer a combined operation either, so this mirrors GitLab's
`GitLabServiceShape` split exactly. `deleteBranch` first looks up the
branch's current `objectId` (`GET .../refs?filter=heads/<branch>`), since
Azure DevOps's ref-update API requires the caller-supplied `oldObjectId` to
match the current tip.

## Considered Options

Using only `.../pullrequests/{id}/statuses` and skipping the policy
evaluations API (as a parallel exploration of the same problem chose) was
considered: it avoids resolving the project GUID and constructing the
`artifactId`, and Azure DevOps's own status/policy split does conflate two
distinct concerns onto one `PullRequestCheckStatus`. It was rejected here
because Azure DevOps repositories commonly gate merges through branch
policies (build validation, required reviewers) with no custom PR status
posted at all — status-only observation would leave such repositories
permanently invisible to Watch. **This mapping is accepted with a known,
unverified risk**: the exact `artifactId` format and the assumption that the
pull-request *list* endpoint's response embeds `repository.project.id` (used
to build it) have not been confirmed against a live Azure DevOps instance.
The first production Azure DevOps repository exercising a branch-policy-only
merge gate is the practical verification point; if the format is wrong,
correct it there. The failure mode if wrong is fail-safe: `mergePullRequest`
reports `missing_successful_checks` (Needs Human) rather than merging without
having actually observed a green check.

Looking up each work item type's actual closed-state name via
`workitemtypes/{type}/states` before closing (rather than always writing the
literal `"Closed"`, as the same parallel exploration chose) was accepted here
specifically because it degrades to that exact literal on any lookup failure,
so it costs nothing when the lookup is unavailable and is strictly more
correct than the literal alone when it succeeds.

## Consequences

- A branch-policy-specific failure (e.g. a required-reviewer policy not yet
  satisfied) surfaces through the same `PullRequestCheckStatus` shape as an
  external CI status, without a separate code path — consistent with how
  Watch already treats every Forge's checks as one aggregate.
- The policy-evaluations `artifactId` construction is unverified against a
  live Azure DevOps organization; the first real Azure DevOps repository
  exercising a branch-policy-only merge gate is the practical verification
  point. If policy evaluations never populate, Azure DevOps merges relying
  solely on branch policy will sit in `missing_successful_checks` Needs Human
  indefinitely until diagnosed and corrected.
- A Scrum-templated Azure DevOps project's work items are written with
  whichever state has category `Completed` (typically "Done"), not a
  hardcoded "Closed" — this is a deliberate improvement over always writing
  the literal.
