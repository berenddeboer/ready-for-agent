# Fair-share Agent Turn admission across repositories

`maxConcurrentAgentTurns` (ADR 0031) admits Agent Turns repository-aware and
fair by default: when a permit frees up and more than one Repository has
pending demand, whichever contending Repository was least recently granted a
permit is admitted next. A Repository with no pending demand is not
considered and does not affect ordering for the Repositories that do. A
single configured Repository, or multiple Repositories with no contention,
behaves exactly as before — this is invisible unless there is genuine,
simultaneous cross-repository demand.

A Repository's already-running Agent Turns keep holding their permits until
they finish, unchanged from before (including a paused Repository's in-flight
turns). Pausing a Repository already stops it from generating new demand, so
it falls out of fair-share consideration without any new interaction.

The existing Agent Turn limiter — which wraps the shared Agent Backend in a
concurrency-limiting gate sized by `maxConcurrentAgentTurns` — already carries
repository identity at the point of contention via its ambient Step Run
context (used before this change only to mark a Step Run `waiting` for UI
purposes), so admission reuses that identity rather than requiring new
plumbing. The plain semaphore is replaced with a small admission structure
that tracks, per repository, the sequence number of its most recently granted
permit (absent = never granted, ranked as the least-recently-serviced of
all) and, per repository, a count of callers currently waiting for one
(pending demand). Ranking only considers repositories currently registered as
waiting: a repository with no pending demand cannot be "owed" a permit it
isn't asking for, and once a repository is granted a permit its rank moves to
the front of the queue for future contention, so a low-volume repository
cannot be starved by a high-volume one's continual demand.

This is rejected as a full priority queue with per-waiter FIFO ordering
across repositories: the config-recheck poll loop the limiter already used
(every 200ms, so raising `maxConcurrentAgentTurns` admits waiters promptly and
lowering it never interrupts in-flight turns) is kept, and each attempt makes
an admission decision against the current shared state rather than each
waiter blocking on a dedicated queue slot. This keeps the limiter's shape
close to before this change and its own existing test suite's fakes
(`Deferred/Ref`-gated Agent Backend) still apply, extended with distinct
repository identities via the same ambient Step Run context.

Taking a permit and pairing it with its guaranteed release are done inside a
single, narrowly-scoped `Effect.uninterruptibleMask` covering only the
admission attempt itself (one `Ref.modify`), mirroring how Effect's own
`Semaphore.withPermitsIfAvailable` couples `take` with registering its
release finalizer. Once admitted, the wait-state reset that fires immediately
after (clearing the waiting-bookkeeping Ref entry and, best-effort,
`clearWaiting`'s SQL write restoring any prior mid-run phase) runs alongside
the turn itself inside that same restored, `Effect.ensuring`-protected region
— interruptible, same as the turn — because the guaranteed release already
covers all of it; only the admission decision itself needs to be atomic with
wiring up that release. The config re-check and the waiting bookkeeping in
the retry loop (for a caller not yet admitted) stay outside the mask
entirely, freely interruptible exactly as before repository-aware fairness.
So a Step Run that is merely queued — never admitted — can still be cancelled
promptly by Pause, Interrupt Work Item, or a productive timeout even if the
database is slow, and a Step Run that was just admitted keeps that same
promptness through its wait-state reset. Splitting "admitted" and "release
wired up" across two separately interruptible steps was tried and rejected:
an interrupt landing in that gap would leak the permit for the remaining life
of the process, silently shrinking effective Agent Turn concurrency below
`maxConcurrentAgentTurns` for every Repository. Making the whole retry loop
— or the whole wait-state reset — uninterruptible was also tried and
rejected: both close the same gap but needlessly delay cancellation behind
config reads or wait-state database writes that the guaranteed release
already makes safe to interrupt.

Worker Slot admission (`maxConcurrentWorkItems`, ADR 0022) is unaffected — it
remains the separate, harness-wide FIFO mechanism it was before.

An optional per-repository guaranteed-minimum Agent Turn floor, layered on
top of this fair-share default, is out of scope here and tracked separately.
