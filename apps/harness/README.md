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

## Production

Build and start the custom Bun server with:

```bash
bunx nx run harness:start
```

Production initializes Keymaxxer in-process and does not start the sidecar.
