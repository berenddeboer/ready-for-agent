---
name: repair-ci-cd-pipeline
description: Repair failing default-branch CI through diagnosis, fixes, PRs, merges, and watching until the repository CI gate reopens. Use for an authorized repository CI repair invocation or an explicit request to repair CI until green.
---

# Repair CI/CD pipeline

Own the repair from diagnosis through observed recovery. Use the assigned build
model throughout; the repair invocation does not require a separate reviewer.

## Establish the repair context

Read the supplied Repository identity, incident and failing-run evidence,
selected CI Gate Definitions, gate-observation interface, working directory,
credential access, and absolute deadline. Discover the Forge, default branch,
repository instructions, verification commands, and CI configuration rather
than assuming a provider, branch name, language, or workflow filename.

An automatic or manually launched repair carries broad authority to restore CI:
change code, CI, infrastructure, credentials, and repository settings as needed;
rerun jobs; create and merge successive PRs. Work within the capabilities of the
available credentials. Record material remote changes in the report. For a
standalone invocation, establish the deadline and authorized objective from the
request before starting; the harness supplies a four-hour deadline at launch.

The deadline covers all work and waiting. Bound commands and watches by the time
remaining, and keep PR/run links and progress available to the supervisor as
you go so interruption does not erase the evidence. There is no PR-count or
attempt-count limit within the deadline.

## Diagnose and reproduce

1. Check current gate health and existing repair PRs first. If the incident has
   already resolved, report recovery instead of publishing an unnecessary fix.
2. Identify each blocking definition, run, job, commit, and conclusion. Inspect
   the complete failing-step evidence, including effective runtime versions.
3. Reproduce the actual failure with the closest feasible local command and
   inputs. Prefer a tight red/green loop, then verify the complete failing step.
   Where local reproduction is impossible, use observed CI evidence and explain
   the gap rather than claiming a local reproduction.

Diagnosis is complete when the failure and its causal evidence are concrete
enough to choose a repair or justified rerun.

## Fix, publish, and merge

1. Use an isolated repair branch based on the current default branch; preserve
   unrelated work. Inspect and reuse unfinished repair work when appropriate.
2. Address the cause, run focused verification, and repeat the original CI step
   where feasible. An error changing into a later error is an unmasked failure,
   not proof the full step is repaired.
3. Publish a PR explaining the cause, net change, failed-run links, and actual
   verification. Inspect PR checks and repository-provided review feedback;
   resolve obstacles to merging using the repair authority supplied above.
4. Merge the repair and record the PR URL and merge commit. Changes made outside
   Git should have their purpose and observed effect recorded alongside it.

## Watch and repeat

Locate default-branch CI runs for the merged commit and watch their actual
conclusions. Keep checking authoritative gate health: the goal is recovery of
all blocking definitions, not just a green PR or the repaired job.

A watch command timing out is inconclusive. Query the Forge for current status
and keep waiting within the absolute deadline if the run is still active.
Classify further failures as persistent, unmasked, transient, or newly introduced
and continue repairing while the gate remains Closed. After a merged repair,
start the next code fix on a fresh branch from the current default branch.

Stop when the gate reopens, including recovery caused by another actor. If a
standalone invocation has no harness gate observer, verify successful recovery
of every supplied blocking definition from current Forge run ordering and
clearly identify that evidence as direct observation. A successful older run
cannot establish recovery when a newer failure is still outstanding.

At the deadline, stop local repair activity and report unresolved status. If an
unrecoverable blocker ends the attempt sooner, report it then. The supervisor
enforces the deadline independently; an agent's success claim does not clear a
harness gate.

## Final report

Include the recovered or unresolved gate status, causes found, fixes and remote
configuration changes, PR URLs and merge commits, CI run URLs and conclusions,
verification performed, remaining active remote jobs, and any unfinished PRs
or blockers. Distinguish observed facts from checks that could not be completed.
