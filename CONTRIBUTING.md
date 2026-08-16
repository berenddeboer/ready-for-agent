# Contributing

Operator install and run instructions live in [README.md](README.md). This file
covers monorepo development of Ready for Agent.

# Getting started

## Prerequisites

Product host tools from the product README: `git`, plus `gh` for GitHub
Repositories and `glab` for GitLab Repositories. Authenticate each Forge CLI
for the Repository's Forge Host.

Also needed to run or test the harness:

1. The selected Agent Backend on PATH (`opencode` by default), authenticated per
   its own documentation.
2. Optional: `keymaxxer` on PATH, or `KEYMAXXER_ENTRYPOINT` pointing at an
   existing entrypoint (no hardcoded machine path). Not used by Grok Build
   Agent Turns.
3. Contributor scripts only: `curl`, used by GitLab e2e and fixture scripts
   such as `scripts/setup-gitlab-e2e-fixture.sh` and
   `scripts/regenerate-e2e-keymaxxer-vault.sh`. It is not required to run the
   operator binary.

## Install with mise

[mise](https://mise.jdx.dev/) 2026.7.0 or later installs the pinned Bun, hk,
and Usage (5.1.0) versions, then workspace dependencies (which apply the
existing Git hooks). Usage lints the operator CLI contract:

```bash
bunx nx run ready-for-agent:lint-usage
```

```bash
git clone git@github.com:berenddeboer/ready-for-agent.git
cd ready-for-agent
mise trust
mise bootstrap
```

Optional browser/e2e setup (installs Chromium and native Playwright
dependencies; not required for ordinary development):

```bash
mise run setup-e2e
```

## Install without mise

Install the Bun version pinned in [`mise.toml`](mise.toml) from
[bun.sh](https://bun.sh/). Operator CLI contract checks also need Usage
`5.1.0` on `PATH`. Then:

```bash
git clone git@github.com:berenddeboer/ready-for-agent.git
cd ready-for-agent
bun install
```

`bun install` runs the root `prepare` script, which installs Git hooks when
`hk` is on PATH (or resolvable through mise) and applies the existing package
setup patches.

Optional browser/e2e setup:

```bash
(cd apps/harness && bunx playwright install --with-deps chromium)
```

## Running the harness

```bash
bunx nx run harness:dev
```

That boots the full Harness (UI + backend) on the monorepo dev path
(`harness:dev`), including the Keymaxxer sidecar when available.

- UI: `http://127.0.0.1:6056`
- GraphQL: `http://127.0.0.1:6056/graphql`
- Sidecar (dev): `127.0.0.1:6057` (preserves Keymaxxer session across reloads; always loopback)

Or with non-standard ports / bind host (`HOST` / `--host`, same semantics as
Vite `server.host`; Sidecar is unchanged):

```
PORT=4021 KEYMAXXER_SIDECAR_PORT=4031 bunx nx run harness:dev
HOST=0.0.0.0 bunx nx run harness:dev
bunx nx run harness:dev --host
bun run ready-for-agent start --host
```

Production-style monorepo start

```bash
bunx nx run harness:start
```

## Database defaults in development

| How you start | Default DB when `SQLITE_DATABASE_PATH` is unset |
| --- | --- |
| Operator binary (`bun run ready-for-agent`) | Platform data dir (`~/.local/share/ready-for-agent/` on Linux, Application Support on macOS), file `ready-for-agent.db` |
| `bunx nx run harness:dev` / `harness:start` | `tmp/ready-for-agent.db` |

`SQLITE_DATABASE_PATH` always overrides. Fully stop the harness before opening
the file with external write tooling (single-process WAL).

# Architecture

This repo is an [Nx monorepo](https://nx.dev/). Your agent will know
how to deal with this.

Architecture notes are in
[ARCHITECTURE.md](ARCHITECTURE.md) and domain language in
[CONTEXT.md](CONTEXT.md).

## Repo map

- `apps/harness` — the product: web UI plus backend server
  (`bunx nx run harness:dev` boots this)
- `apps/ready-for-agent` — the published npm CLI wrapping the harness
- `apps/keymaxxer-sidecar` — optional secrets sidecar
- `packages/` — the libraries; start with:
  - `work-item-lifecycle` — the lifecycle engine driving Work Items
  - `lifecycle-model` — states and transitions generated from `ontology/`
  - `agent-backend` plus `opencode`, `codex`, `grok`, `claude` — Agent
    Backend adapters
  - `github-service`, `gitlab-service` — Forge integrations
  - `graphql-schema`, `graphql-api`, `graphql-client` — the GraphQL
    contract, server, and generated client
- `ontology/` — the machine-readable domain model, source of truth for
  the Work Item lifecycle
