# Limit concurrent OpenCode sessions

The harness Config setting `maxConcurrentOpencodeSessions` (default 2) caps how many concurrent OpenCode CLI processes lifecycle work may spawn. Enforcement is a shared Effect semaphore around lifecycle `Opencode.start` / `Opencode.continue` (not `listModels` or Issue Polling). Config is re-read on each acquire; lowering the limit does not interrupt in-flight processes.

Lifecycle jobs use claim-and-fork on the `jobs` queue with a fiber budget of at least `max(maxConcurrentWorkItems, 2 × maxConcurrentOpencodeSessions)` so non-OpenCode Lifecycle Steps can still progress while OpenCode slots are saturated and Worker Slot admission is not undercut (ADR 0022). Issue Polling remains a separate serial lane (ADR 0019). This extends ADR 0007/0008: lifecycle work may run in parallel across Work Items, still at most one running Step Run per Work Item.
