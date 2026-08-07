# Process-local GitHub Operation Coordinator

Each Harness application runtime owns one scoped **GitHub Operation Coordinator**. It admits exactly one replay-safe **Harness GitHub Operation** at a time across that runtime's ambient GitHub GraphQL and REST activity. The permit spans the complete operation, including credential acquisition, pagination, fallback requests, and sequential mutations; an active operation is never preempted and releases the permit only when it settles.

Admission accepts a closed semantic origin rather than a numeric priority: Operator, Lifecycle, Polling, or Background. Normal admission follows that order with FIFO within each origin. When any request has waited 60 seconds, the globally oldest waiting request is admitted next. Cancellation before admission removes the operation; cancellation after dispatch does not revoke its permit. Successful local cache hits remain outside the coordinator because they make no GitHub request. Every operation is replay-safe: it is idempotent or revalidates the relevant remote postcondition before replaying a mutation.

The coordinator is deliberately neither a host-wide queue nor a rate limiter. Its scope is one Harness runtime and it performs no proactive quota budgeting or ordinary pacing. Agent Turn GitHub access, other Harness runtimes, unrelated shells and applications, git transport, and GitHub Actions remain best-effort traffic outside the guarantee. The fixed concurrency of one is not Harness Config.

The initial implementation traces the complete ambient credential path. Later work brings Keymaxxer-backed helpers and typed GitHub-throttle postponement behind the same runtime-scoped coordinator without changing this permit contract.
