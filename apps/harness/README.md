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

- **Operator binary / product default:** platform data dir
  (`~/.local/share/ready-for-agent/` on Linux, Application Support on macOS),
  database file `ready-for-agent.db`.
- **Monorepo `nx run harness:dev` / `harness:start`:** `tmp/ready-for-agent.db`
  when `SQLITE_DATABASE_PATH` is unset.
- **Override:** `SQLITE_DATABASE_PATH` always wins.

Fully stop the harness before opening that file with external write tooling.
The harness uses single-process default WAL; concurrent writers are not
supported. Stale `*.db-tshm` files from older multiprocess-WAL runs may remain;
Turso rebuilds or ignores them after a clean mode switch, and no data migration
is required.

## Browser open

Production `harness:start` opens the default browser to the local UI after
listen unless `NO_BROWSER` is set. The operator binary also supports
`--no-open`.

## Production

Build and start the custom Bun server with:

```bash
bunx nx run harness:start
```

Production uses `run-with-keymaxxer-sidecar` so the real Keymaxxer Sidecar is
started (or reused when `KEYMAXXER_SIDECAR_URL` is already set).

## Live end-to-end

One Gherkin operator journey (`e2e/features/add-and-refresh-repository.feature`)
runs the production build against a fresh isolated Harness database, clones the
private End-to-End Fixture Repository through Keymaxxer, adds it with the real
CLI, and waits for credential activation's automatic first Refresh Job.

```bash
bunx nx run harness:e2e
```

Local runs leave `~/.keymaxxer` untouched and use your matching
`provider=github` / `account=berenddeboer/test-ready-for-agent` credential
(normal Keymaxxer prompts allowed). CI will unlock the checked-in fixture vault
with `E2E_KEYMAXXER_MASTER_KEY` (see `docs/e2e-fixture.md` and ADR 0021).
