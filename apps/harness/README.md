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

The SPA and GraphQL endpoint are available on the same application server
(loopback by default):

- `http://127.0.0.1:6056`
- `http://127.0.0.1:6056/graphql`

The sidecar listens separately on `127.0.0.1:6057` only to preserve the
Keymaxxer session across application-server reloads (always loopback; not
affected by `--host` / `HOST`).

Override port, bind host, or sidecar port independently, and point operator
commands at a non-default Harness GraphQL endpoint with
`READY_FOR_AGENT_GRAPHQL_URL`:

```bash
PORT=7000 bun run ready-for-agent start
# all interfaces (Vite-style --host / HOST); flag wins over env
bun run ready-for-agent start --host
HOST=0.0.0.0 bun run ready-for-agent start
bun run ready-for-agent start --host 192.168.1.10
# monorepo nx targets accept the same flag / env
PORT=7000 bunx nx run harness:dev --host
HOST=0.0.0.0 bunx nx run harness:dev
KEYMAXXER_SIDECAR_PORT=7001 bun run ready-for-agent start
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:7000/graphql \
  bun run ready-for-agent add /path/to/local/repo
# non-loopback Harness:
READY_FOR_AGENT_GRAPHQL_URL=http://<reachable-host>:<port>/graphql \
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

The Gherkin operator journeys under `e2e/features/` run the production build
against a fresh isolated Harness database. There are **three** live suites
plus a local/main union (separate Playwright / `webServer` boots; issues
#958 and #999). UI-history (`E2E_HARNESS_WORKERS>1`) starts one Harness per
Playwright worker instead of a shared `webServer` (issue #1000):

| Target | Tag filter | Product PATH | Keymaxxer | What it covers |
| --- | --- | --- | --- | --- |
| `harness:e2e-no-backend` | `--grep @no-backend` | `E2E_AGENT_BACKEND_MODE=no-opencode` (ambient `opencode` stripped; fail-closed if still resolvable) | `KEYMAXXER_ENABLED=false` (vault-free) | Default Agent Backend Unavailable + first-run UI when OpenCode is absent; pure-absence and mixed-Ready (fake Claude) |
| `harness:e2e-live-forge` | `--grep @live-forge` | Default (OpenCode expected in CI) | Fixture vault credential | Add/refresh fixture Repositories, Intake, catalog-only fixture path |
| `harness:e2e-ui-history` | `--grep @ui-history` | Default (OpenCode allowed for Settings catalog) | `KEYMAXXER_ENABLED=false` (no fixture vault); isolated Harness per Playwright worker (`E2E_HARNESS_WORKERS>1`) | Settings / Repository settings / Session Telemetry history and Kanban that seed persistence |
| `harness:e2e` | `--grep-invert @no-backend` | Default (OpenCode expected in CI) | Fixture vault credential | Local / `main` union of live-Forge and UI-history |

```bash
# Vault-free default-backend / first-run (no OpenCode install required)
bunx nx run harness:e2e-no-backend

# UI-history only (no fixture vault or clone)
bunx nx run harness:e2e-ui-history

# Live-Forge fixture path (requires vault)
bunx nx run harness:e2e-live-forge

# Union of live-Forge + UI-history (excludes @no-backend)
bunx nx run harness:e2e
```

Overnight published-install smoke (`.github/workflows/overnight-install-smoke.yml`)
remains the packaging multi-arch gate; it does not replace these suites.

### Vault-backed suite (`harness:e2e` / `harness:e2e-live-forge`)

Non-interactive by default and requires a Keymaxxer credential before it
starts the Harness, Sidecar, or CLI at all — it never falls back to silently
prompting:

- **Fixture vault (default, non-interactive):** set
  `E2E_KEYMAXXER_MASTER_KEY` (or the legacy `KEYMAXXER_MASTER_KEY`) to unlock
  the checked-in fixture vault into a temporary `HOME`, with
  `KEYMAXXER_APPROVE=deny` so nothing can prompt. CI always uses this mode.
- **Ambient vault (explicit local opt-in only):** set
  `E2E_ALLOW_KEYMAXXER_PROMPTS=1` to intentionally run against your own
  `~/.keymaxxer` vault, with your matching fixture credentials (normal
  Keymaxxer prompts allowed):
  - GitHub: `provider=github` / `account=berenddeboer/test-ready-for-agent`
  - GitLab: `provider=gitlab` /
    `account=git.drupalcode.org/<fixture-project-path>`
- **Neither set:** live e2e fails fast with a diagnostic instead of starting
  anything.

The GitLab scenario soft-skips until the fixture vault includes the GitLab
secret; set `E2E_REQUIRE_GITLAB=1` to fail closed after bootstrap. See
`docs/e2e-fixture.md` and `docs/adr/0021-live-harness-end-to-end-test.md`.

### Vault-free suites (`harness:e2e-no-backend`, `harness:e2e-ui-history`)

Do **not** require `E2E_KEYMAXXER_MASTER_KEY` (fork-PR safe). The supervisor
soft-disables Keymaxxer, always prepends a fake `claude` CLI, and in
`no-opencode` mode (`e2e-no-backend` only) removes every PATH directory that
provides ambient `opencode` / `grok` / `codex` / `claude` so a local
developer install cannot silently green pure-absence or mixed-Ready
scenarios. It fails closed if those binaries still resolve (except the fake
`claude`). Claude readiness is toggled per scenario via the live-harness
control protocol (`firstParty` / `unauthenticated`). `e2e-ui-history` leaves
OpenCode on PATH when present so Settings catalog coverage can use it.
