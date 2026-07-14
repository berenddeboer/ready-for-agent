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

When the harness uses a non-standard port, point the CLI at its GraphQL
endpoint with `READY_FOR_AGENT_GRAPHQL_URL`:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:4300/graphql \
  bun run harness-cli add /path/to/local/repo
```

## Production

Build and start the custom Bun server with:

```bash
bunx nx run harness:start
```

Production initializes Keymaxxer in-process and does not start the sidecar.
