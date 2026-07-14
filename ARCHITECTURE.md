# Design

- SPA uses TanStack Start SPA mode; no need for SSR
- A single loopback application server serves the SPA and `/graphql`; see `docs/adr/0005-tanstack-start-single-application-server.md`
- The GraphQL contract, generated genql client, and Yoga handler are separate packages
- A development-only Keymaxxer sidecar survives application-server reloads; production uses Keymaxxer in-process
- Database is Turso database (sqlite)
- Backend is Effect TS
- Services are implemented as Effect TS
- Separate job worker who handles jobs
- UI is responsive: anything that takes long is put in a queue and handled by the job worker
- Prefer Bun APIs.
- All action/work is done by clanker, harness only does the purely deterministic steering,
  while always consulting the clanker for advice.
- Use tailwind
