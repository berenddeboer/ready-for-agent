# Design

- SPA uses TanStack Start SPA mode; no need for SSR
- A single loopback application server serves the SPA and `/graphql`; see `docs/adr/0005-tanstack-start-single-application-server.md`
- The GraphQL contract, generated genql client, and Yoga handler are separate packages
- A shared Keymaxxer Sidecar owns one keyholder and exposes Streamable HTTP MCP to Harness and OpenCode (dev and production); capability URL is stdout-bootstrapped, never on disk
- Database is Turso database (sqlite)
- Backend is Effect TS
- Services are implemented as Effect TS
- The application runtime hosts scoped job worker fibers; see `docs/adr/0007-host-job-worker-in-harness.md` and `docs/adr/0019-serialize-issue-polling-with-keyed-recurring-jobs.md`
- Every job implementation is an Effect; workers compose and run those Effects for work claimed from the database queue
- Work Item lifecycle jobs use the `jobs` queue; manual Refresh Jobs use the high-priority `issue-refresh` queue. Independent workers claim each queue; Issue Refresh Jobs execute serially on the polling lane while lifecycle work may run in parallel
- UI is responsive: anything that takes long is put in a queue and handled by the job workers
- Successful Issue reconciliation publishes a Repository-specific issues invalidation and a repositories invalidation so subscribed clients refetch Issues and `issuesReconciledAt`; no client-facing job history or status snapshots are maintained
- Each worker executes one job at a time with five-minute claim visibility; Refresh Job reconciliation failures are terminal, while an abandoned claim may be redelivered once after interruption
- Workers poll about every 1.5s while idle (Effect `Schedule.spaced` + `Schedule.jittered`, ~0.8–1.2×) and log and recover from queue infrastructure errors instead of permanently terminating their fibers
- On startup, any persisted `refresh-repository` rows still on `jobs` are moved once into `issue-refresh` so they are not dropped, duplicated, or claimed by both workers
- Queue methods acquire their SQL dependency when constructing the queue layer and return self-contained Effects; complete issue #13 before implementing the worker
- Public Job IDs use the canonical `qjob-<ULID>` format
- Prefer Bun APIs.
- All action/work is done by clanker, harness only does the purely deterministic steering,
  while always consulting the clanker for advice.
- Use tailwind
