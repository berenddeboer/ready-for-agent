---
status: accepted
amends:
  - 0017
  - 0055
  - 0068
---

# Delegate repository CI repair to one bounded build agent

The Repository CI Gate detects default-branch failures but currently relies on
an operator to arrange repairs. Introduce a lightweight, incident-scoped repair
invocation: one agent using the Repository's effective Agent Backend and build
Agent Model owns diagnosis, repair PRs, merging, and watching CI until the gate
reopens. This is an accepted design awaiting implementation, not a description
of an already shipped launcher.

## Ownership and authority

Use one build-model session for the whole repair. The agent may iterate through
as many fixes and PRs as fit its deadline; there is no round limit, separate
review-model pass, or Work Item lifecycle around these PRs. The generic
[repair skill](../../.agents/skills/repair-ci-cd-pipeline/SKILL.md) supplies the
agent's operating procedure. Runtime delivery of that skill to the selected
backend is part of the implementation.

Enabling automatic repairs or explicitly starting a repair authorizes the agent
to do what is needed to restore CI within the capabilities of its supplied
credentials. This is broad repair authority, including application and CI code,
reruns, repeated PR creation and merging, infrastructure, credentials, and
repository settings when needed. There is no additional product-level action
allowlist or approval step. The four-hour deadline bounds execution, not the
scope of authorized repair actions. Credential or platform refusals remain real
constraints and are reported when the agent cannot resolve them.

This deliberately departs from ADR 0017's harness-owned merging and ADR 0055's
harness-enforced merge-check aggregate for this standalone repair invocation.
Ordinary Work Items retain those policies. The new repository-level repair
button replaces creating a repair Work Item through Implement CI Repair;
existing authorized Work Items retain their recorded incident authorization.
This does not reinterpret their existing checks or merge policies.

## Launch and supervision

- Ship execution for GitHub first; keep the skill Forge-neutral. GitLab and
  Azure DevOps gate observation retain their existing behaviour.
- Add an automatic-repair checkbox to Repository settings, defaulting to off
  for both existing and new Repositories. Provide a manual start/retry button
  during a Closed incident regardless of the checkbox.
- A confirmed failure closing an enabled Repository's gate can request repair.
  Pending CI or Degraded observation alone cannot. Respect Repository Paused
  semantics for automatic selection; explicit manual requests remain allowed.
- Atomically admit at most one queued or running repair per Repository. Polls,
  additional failures in the same incident, and concurrent button clicks must
  not create competing agents.
- Use existing Agent Turn capacity without reserved capacity or preemption.
  Watching CI occupies that capacity. Resolve the effective backend and build
  selection at launch using existing overrides and readiness checks.
- Start a four-hour wall-clock deadline when the agent launches, excluding
  queue time. Supply the absolute deadline to the agent and enforce it in the
  supervising process across diagnosis, commands, PRs, merges, and watching.
- Persist the incident association, admission/launch information, deadline,
  session reference, outcome, and discovered PR links. This is minimal process
  supervision and duplicate suppression, not a second Work Item lifecycle.
- On failure, timeout, or service interruption, report the outcome and require
  explicit retry. Polling or toggling the checkbox must not replenish an
  exhausted incident's automatic attempt. A manual retry receives a new
  four-hour budget; a later, distinct incident can start a new automatic attempt.
- On restart, reconcile an interrupted invocation to needing attention rather
  than resuming automatically. Establish that its old process has stopped
  before admitting another repair. Timeout stops local execution; already
  submitted Forge jobs and merged changes may continue and must be reported.

## Completion and visibility

The existing gate observer remains authoritative. Success means the Repository
CI Gate reopens, including when somebody else restores it. A green local check,
green PR, or one successful workflow does not suffice while another latched
failure keeps the gate Closed. Observe post-merge runs and their commit identity
to explain the result; a newer independent failure belongs to the same ongoing
repair while the incident remains open. A reopened gate ends that invocation;
a later incident is a separate request.

Show queued/running repair activity, its deadline once launched, PR links, and
its final outcome in the repository CI view. Agent exit alone cannot establish
success or clear the gate. If the gate remains Closed, ordinary work continues
waiting and the outcome tells the operator what requires attention. Preserve
the final report and available links even after interruption. Already-created
PRs remain visible for the next explicit repair to inspect.

## Trade-off

We choose fast delivery and agent-owned adaptation over deterministic per-step
review, merge, and recovery orchestration. Long CI watches consume an agent
slot, and broad authority means the agent can change more than source code.
The initial controls are explicit opt-in, per-Repository exclusivity, a hard
deadline, durable outcomes, and explicit retries. A richer repair lifecycle is
deferred until experience demonstrates a need.
