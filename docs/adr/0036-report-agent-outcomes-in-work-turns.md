# Report Agent-reported Outcomes in work turns

Status: accepted

An Agent Turn that performs lifecycle work also reports the Agent-reported Outcome needed to choose the next lifecycle transition in its final response. A separate outcome-classification Agent Turn is justified only when intervening Harness-controlled work or observation creates evidence required for the decision, or as one bounded recovery when an otherwise valid work turn omits its outcome; malformed, duplicate, or contradictory outcomes fail strictly. This protocol applies to every Agent Backend.

PR Status Check investigation, its focused recovery attempt, and PR merge-conflict resolution therefore combine work and outcome reporting instead of unconditionally continuing the Session for a verdict. The response may contain a concise work and verification summary followed by exactly one final outcome line. Existing lifecycle semantics and the single status-check recovery budget remain unchanged. Review's missing-outcome fallback remains a bounded recovery, while Review Rerun Assessment remains separate because nested Pre-Commit can create new decision evidence.

In the 24 measurable OpenCode Work Item Sessions among the 25 latest Work Item PRs inspected on 2026-07-24, the 33 unconditional status-check and merge-conflict verdict turns consumed 6,938,788 tokens: 15.9% on top of their associated work turns and 2.3% of main-Session usage. Nearly all measured ruling-only usage was input or cache context rather than generated output, so combining turns removes repeated context processing without requiring lifecycle-token telemetry or schema changes.
