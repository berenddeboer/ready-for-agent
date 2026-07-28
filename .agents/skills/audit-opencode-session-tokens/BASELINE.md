# Baseline: processfocus/monorepo, 2026-07-28

## Cohort

- Source: `tmp/ready-for-agent.db`
- Repository: `processfocus/monorepo`
- Agent Backend: OpenCode
- Roots: latest 30 Work Item Sessions
- Work Items created: 2026-07-22 through 2026-07-27
- Outcome: all 30 completed
- Root model: `openai/gpt-5.6-sol`, medium

The Harness database supplied Work Item and root Session identities. Token and transcript metadata came from the database returned by `opencode db path`. Inclusive totals recursively include OpenCode child Sessions.

## Usage

| Metric | Root only | Inclusive |
|---|---:|---:|
| Session rows | 30 | 170 |
| Tokens | 399,249,499 | 496,615,065 |
| Average per Work Item | 13,308,317 | 16,553,836 |
| Median per Work Item | 10,262,912 | 12,586,286 |
| P90 per Work Item | 22,269,118 | 34,268,979 |
| Model calls | 3,041 | 4,541 |

Inclusive token components:

- Input: 69,579,789
- Output: 1,234,439
- Reasoning: 525,957
- Cache read: 425,274,880
- Cache write: 0
- Child-session tokens: 97,365,566

## Drivers

- Status-check work: 121 turns and 126,530,623 root tokens.
- Legacy status outcome-only turns: 106 turns and 15,872,659 root tokens. This path was removed during the cohort and was absent from the latest ten roots.
- Status recovery: 10 turns and 4,080,677 root tokens.
- Green-only status work: 114 of 121 handoffs.
- Green-only handoffs ending `PROCESSED`: 70 handoffs and 61,040,384 root tokens, including a paired legacy outcome turn when present.
- Implement: 114,238,533 root tokens.
- Commit: 31,633,331 root tokens.
- Create PR: 34,847,676 root tokens.
- Review, apply, and rerun assessment: 42,369,987 root tokens.
- Pre-Commit fix turns: 9,797,728 root tokens.
- Pre-Commit diagnosis children: 26 Sessions and 22,862,511 tokens.
- Review-command children: 18 Sessions and 11,470,623 tokens.

Root model calls averaged 130,952 context tokens and 337 generated tokens. The first root call averaged 13,345 context tokens; the final root call averaged 169,597. No root Session recorded compaction.

Root tool output totaled approximately 13.9 million characters. The largest contributors were read, Bash, Keymaxxer, and grep.

## Decisions Triggered

- [Issue #526](https://github.com/berenddeboer/ready-for-agent/issues/526): process no-review green Status Check Handoffs without an Agent Turn.
- [Issue #527](https://github.com/berenddeboer/ready-for-agent/issues/527): attempt Commit and Create PR natively before Agent repair fallback.

## Caveats

- Reported totals include cache reads; cached and uncached tokens need not have equal price.
- OpenCode recorded cost as zero, so this baseline cannot compare currency.
- Issue complexity differs between cohorts; compare phase counts and medians with totals.
- Repository guidance was inspected at the then-current checkout, not reconstructed at every historical Session commit.
