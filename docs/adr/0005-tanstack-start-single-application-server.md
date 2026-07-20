---
status: accepted
---

# TanStack Start owns the single application server

Ready for Agent uses TanStack Start in SPA mode as its sole loopback application server, on `127.0.0.1:6056` by default. The same server delivers the SPA and exposes `/graphql`; there is no listener on the former API port `3001`, and both the SPA and CLI use GraphQL rather than introducing TanStack server functions as a second application interface.

Live application notifications also use GraphQL subscriptions rather than a separate event endpoint. Repository membership changes publish a payload-free invalidation signal after persistence; each connected UI then refetches the authoritative Configured Repositories query. The subscription is deliberately not an event log: reconnecting or resuming clients refetch instead of replaying missed changes.

The `/graphql` server route delegates its `Request` to a framework-neutral Yoga handler from `@ready-for-agent/graphql-api`. That package owns schema assembly, resolvers, and GraphQL error mapping while accepting the process-wide Effect runtime; the Start server composes and initializes the live runtime before listening and disposes it on shutdown. The SDL remains in `@ready-for-agent/graphql-schema`, and generated caller code remains in `@ready-for-agent/graphql-client`.

Production uses a custom Bun server adapter and an in-process Keymaxxer client. Development instead starts the separate `apps/keymaxxer-sidecar` loopback process so TanStack server reloads do not repeat vault approval prompts; this sidecar is not a public application server. The application validates its loopback host and accepts GraphQL browser requests only from its own origin, while allowing non-browser clients such as the CLI.

Rejected alternatives were retaining a separately listening Yoga application, which required an internal port and proxy without creating a useful isolation boundary; adopting SSR, which adds server/client execution complexity without a current rendering requirement; polling for Repository changes, which creates continuous database and credential-service work; and adding a dedicated SSE or WebSocket endpoint, which creates a second application interface for a one-way invalidation signal.
