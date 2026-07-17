# Harness

## Development

From the repository root, start the TanStack Start application server and its
development-only Keymaxxer sidecar with:

```bash
bunx nx run harness:dev
```

The SPA and GraphQL endpoint are available on the same loopback server:

- `http://127.0.0.1:4200`
- `http://127.0.0.1:4200/graphql`

The sidecar listens separately on `127.0.0.1:5032` only to preserve the
Keymaxxer session across application-server reloads.

Start the Harness (or use the unified operator binary):

```bash
bun run ready-for-agent start
# equivalent monorepo path:
bunx nx run harness:dev
```

When the harness uses a non-standard port, point operator commands at its
GraphQL endpoint with `READY_FOR_AGENT_GRAPHQL_URL`:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:4300/graphql \
  bun run ready-for-agent add /path/to/local/repo
```

## Database

By default the harness stores application data in `tmp/ready-for-agent.db`
(override with `SQLITE_DATABASE_PATH`). Fully stop the harness before opening
that file with external write tooling. The harness uses single-process default
WAL; concurrent writers are not supported. Stale `*.db-tshm` files from older
multiprocess-WAL runs may remain; Turso rebuilds or ignores them after a clean
mode switch, and no data migration is required.

## Production

Build and start the custom Bun server with:

```bash
bunx nx run harness:start
```

Production initializes Keymaxxer in-process and does not start the sidecar.
