---
name: audit-opencode-session-tokens
description: Audit OpenCode token usage for Harness Work Item Sessions and compare cohorts.
disable-model-invocation: true
---

# Audit OpenCode Session Tokens

Measure where OpenCode tokens go across a Repository's recent Work Items. Treat each Work Item Session as a root and include every OpenCode child Session so task and review usage is not hidden.

## Inputs

Use these defaults unless the user supplies alternatives:

- Harness database: `tmp/ready-for-agent.db`
- Cohort size: 30
- Agent Backend: OpenCode
- OpenCode database: resolve with `opencode db path`

The Repository `owner/name` is required. Ask only when it cannot be inferred from the request.

## Process

### 1. Run The Audit

From the Ready for Agent workspace root, run:

```bash
bun .agents/skills/audit-opencode-session-tokens/scripts/audit.ts \
  --harness-db tmp/ready-for-agent.db \
  --repository owner/name \
  --limit 30
```

Use `--json` when saving or programmatically comparing results. Use `--opencode-db <path>` only when `opencode db path` does not identify the database that owns the referenced Sessions.

Completion criterion: the report contains the requested number of root Sessions, or explicitly reports that fewer eligible Sessions exist.

### 2. Validate The Cohort

Confirm all of the following before interpreting results:

- Repository identity and `agent_backend = opencode` filter are correct.
- Root Session count matches the requested limit when enough Work Items exist.
- Cohort timestamps are plausible.
- Root token components sum to the reported root total.
- Inclusive totals contain root plus recursively discovered child Sessions.

OpenCode's `cost` may be zero even when tokens were consumed. Report that limitation rather than estimating currency. Keep cache-read tokens separate because their price and quota treatment can differ from uncached input.

Completion criterion: every discrepancy is resolved or called out as a data limitation.

### 3. Diagnose Amplification

Interpret the report in this order:

1. Context versus generation: compare input plus cache reads with output plus reasoning.
2. Session replay: compare first-call and final-call context, model-call count, and root context per call.
3. Lifecycle phases: rank Implement, status-check work, Commit, Create PR, Review, and Pre-Commit by root tokens.
4. Status checks: separate green-only, red-only, and mixed handoffs; identify green-only `PROCESSED` no-ops.
5. Descendants: rank general tasks, exploration, Pre-Commit diagnosis, and review-command children.
6. Tool growth: rank tools by output characters and look for repeated GitHub/log retrieval or large read/command output.
7. Outliers: inspect the highest inclusive-token Work Items without dumping transcript content.

Do not print raw prompts, source files, logs, tool output, reasoning, or encrypted metadata. Aggregate metadata is enough for this audit and avoids exposing repository or credential material.

Completion criterion: every major token category has a measured cause, not a speculative one.

### 4. Separate Harness And Repository Causes

Inspect current code only after the quantitative ranking identifies a cause:

- Harness: trace the relevant Lifecycle Step, Session reuse, child-session creation, retries, and telemetry aggregation.
- Repository: inspect current root guidance, routed nested guidance, skill descriptions, context documents, and summary wrappers.

Distinguish current guidance from historical guidance used by the cohort. Never infer that every tracked `AGENTS.md`, skill body, context document, or ADR was ambient; verify loading or observed reads. Prefer a short current-guidance inventory over loading every document.

Completion criterion: recommendations state whether the Harness, Repository, or both own the change.

### 5. Compare

When comparing with an earlier run:

- Use the same Repository, cohort size, backend filter, and inclusive-token definition.
- Compare medians and per-Work-Item averages, not totals alone.
- Compare lifecycle shares and counts so a different issue mix is visible.
- Call out shipped behavior changes that make cohorts structurally different.
- Treat cache-read reductions separately from uncached-input reductions.

The first recorded baseline is [BASELINE.md](BASELINE.md). It is evidence for the July 2026 cohort, not a permanent target.

Completion criterion: the report says what improved, regressed, and remains inconclusive because of cohort mix.

## Report Shape

Return these sections:

1. Verdict
2. Scope and caveats
3. Root and inclusive usage
4. Primary drivers with measured impact
5. Harness findings
6. Repository-guidance findings
7. Prioritized recommendations
8. Comparison with baseline, when requested

State whether any files were changed.
