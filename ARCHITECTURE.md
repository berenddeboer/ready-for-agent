# Design

- SPA uses TanStack Start SPA mode; no need for SSR
- A single loopback application server serves the SPA and `/graphql`; see `docs/adr/0005-tanstack-start-single-application-server.md`
- The GraphQL contract, generated genql client, and Yoga handler are separate packages
- A shared Keymaxxer Sidecar owns one keyholder and exposes Streamable HTTP MCP to Harness and OpenCode (dev and production); capability URL is stdout-bootstrapped, never on disk
- Database is Turso database (sqlite)
- Backend is Effect TS
- Services are implemented as Effect TS
- The application runtime hosts a scoped job worker service whose Effect fibers handle jobs; see `docs/adr/0007-host-job-worker-in-harness.md`
- Every job implementation is an Effect; the job worker composes and runs those Effects for work claimed from the database queue
- A tagged payload in the shared `jobs` queue selects the Job Effect; the worker owns claim, decoding, dispatch, acknowledgement, and failure handling
- UI is responsive: anything that takes long is put in a queue and handled by the job worker
- Successful Issue reconciliation publishes a Repository-specific GraphQL invalidation so subscribed clients can refetch; no client-facing job history or status snapshots are maintained
- The first worker executes one job at a time with five-minute claim visibility; job failures are terminal, while an abandoned claim may be redelivered once after interruption
- The scoped worker polls once per second while idle and logs and recovers from queue infrastructure errors instead of permanently terminating its fiber
- Queue methods acquire their SQL dependency when constructing the queue layer and return self-contained Effects; complete issue #13 before implementing the worker
- Public Job IDs use the canonical `qjob-<ULID>` format
- Prefer Bun APIs.
- All action/work is done by clanker, harness only does the purely deterministic steering,
  while always consulting the clanker for advice.
- Use tailwind
