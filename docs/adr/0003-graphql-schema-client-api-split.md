---
status: superseded by ADR-0005
---

# GraphQL SDL, genql client, and Yoga API as separate packages

The GraphQL contract is SDL in `@ready-for-agent/graphql-schema` (schema only). Typed callers use a genql client generated on demand in `@ready-for-agent/graphql-client`. The HTTP server is `apps/api` (Bun + GraphQL Yoga) with stub resolvers until real services exist. The SPA (`apps/harness` on port 4200) proxies `/graphql` to the API; the CLI defaults to `http://127.0.0.1:4200/graphql`. Rejected: schema+client in one package (muddies server vs consumer deps), genql per consumer (drift), Yoga inside Vite middleware (dev-only), CLI talking to the API port directly (two public ports).
