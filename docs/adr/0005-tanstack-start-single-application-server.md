---
status: accepted
---

# TanStack Start owns the single application server

Ready for Agent uses TanStack Start in SPA mode as its sole application server, on `127.0.0.1:6056` by default (loopback-only). Operators may opt into a non-loopback bind with `ready-for-agent start --host` / `--host <addr>` or the `HOST` environment variable (Vite-style: bare `--host` or `HOST=true` / `0.0.0.0` listens on all interfaces; a concrete address binds that interface only; the flag wins when both are set). Port remains `PORT` (default `6056`). The same server delivers the SPA and exposes `/graphql`; there is no listener on the former API port `3001`, and both the SPA and CLI use GraphQL rather than introducing TanStack server functions as a second application interface.

Live application notifications also use GraphQL subscriptions rather than a separate event endpoint. Repository membership changes publish a payload-free invalidation signal after persistence; each connected UI then refetches the authoritative Configured Repositories query. The subscription is deliberately not an event log: reconnecting or resuming clients refetch instead of replaying missed changes.

The `/graphql` server route delegates its `Request` to a framework-neutral Yoga handler from `@ready-for-agent/graphql-api`. That package owns schema assembly, resolvers, and GraphQL error mapping while accepting the process-wide Effect runtime; the Start server composes and initializes the live runtime before listening and disposes it on shutdown. The SDL remains in `@ready-for-agent/graphql-schema`, and generated caller code remains in `@ready-for-agent/graphql-client`.

Production uses a custom Bun server adapter and an in-process Keymaxxer client. Development instead starts the separate `apps/keymaxxer-sidecar` loopback process so TanStack server reloads do not repeat vault approval prompts; this sidecar is not a public application server and remains bound to `127.0.0.1` only (ADR 0004 / capability model unchanged).

Host admission on the application server depends on the bind host: a concrete bind address (e.g. `127.0.0.1` or a single LAN IP) rejects requests whose URL hostname does not match (HTTP 421 Invalid Host); a wildcard bind (`0.0.0.0` or `::`) admits any Host because clients send a LAN IP or hostname, never the wildcard literal. GraphQL browser requests still require same-origin (`isSameOriginRequest` in `@ready-for-agent/graphql-api`); that check is not weakened when the listener is non-loopback. Browser auto-open uses loopback (`http://127.0.0.1:<port>/`) for wildcard binds so the local opener never navigates to `http://0.0.0.0:...` or `http://[::]:...`; for a concrete bind address it opens that address so the browser hits the socket that was actually bound. Listen URLs bracket IPv6 authorities (`http://[::]:6056/`).

Rejected alternatives were retaining a separately listening Yoga application, which required an internal port and proxy without creating a useful isolation boundary; adopting SSR, which adds server/client execution complexity without a current rendering requirement; polling for Repository changes, which creates continuous database and credential-service work; and adding a dedicated SSE or WebSocket endpoint, which creates a second application interface for a one-way invalidation signal.
