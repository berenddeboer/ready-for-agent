# Harness

Operator install: [README.md](../../README.md). Monorepo workflow:
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## Development

From the repository root, start the TanStack Start application server and its
Keymaxxer sidecar with the unified operator binary or Nx:

```bash
bun run ready-for-agent start
# equivalent:
bunx nx run harness:dev
```

The SPA and GraphQL endpoint are available on the same loopback server:

- `http://127.0.0.1:6056`
- `http://127.0.0.1:6056/graphql`

The sidecar listens separately on `127.0.0.1:6057` only to preserve the
Keymaxxer session across application-server reloads.

Override either listener independently, and point operator commands at a
non-default Harness GraphQL endpoint with `READY_FOR_AGENT_GRAPHQL_URL`:

```bash
PORT=7000 bun run ready-for-agent start
KEYMAXXER_SIDECAR_PORT=7001 bun run ready-for-agent start
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:7000/graphql \
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
listen unless `NO_BROWSER` or `--no-open` is set. The operator binary also
supports `--no-open`.

## Production

Build and start the custom Bun server with:

```bash
bunx nx run harness:start
```

Production startup is owned by one lifecycle in `server.ts`: database
preparation and migrations, Keymaxxer Sidecar coordination, application
runtime and HTTP listener, browser opening, and signal-driven cleanup. The
Sidecar is started (or reused when `KEYMAXXER_SIDECAR_URL` is already set)
without wrapping the Harness in a second coordinator process.

## Live end-to-end

One Gherkin operator journey (`e2e/features/add-and-refresh-repository.feature`)
runs the production build against a fresh isolated Harness database, clones the
private End-to-End Fixture Repository through Keymaxxer, adds it with the real
operator binary, and waits for credential activation's automatic first Refresh
Job.

```bash
bunx nx run harness:e2e
```

Local runs leave `~/.keymaxxer` untouched and use your matching
`provider=github` / `account=berenddeboer/test-ready-for-agent` credential
(normal Keymaxxer prompts allowed). CI will unlock the checked-in fixture vault
with `E2E_KEYMAXXER_MASTER_KEY` (see `docs/e2e-fixture.md` and ADR 0021).
