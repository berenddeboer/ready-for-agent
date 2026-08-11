# Contributing

Operator install and run instructions live in [README.md](README.md). This file
covers monorepo development of Ready for Agent.

# Getting started

## Prerequisites

1. [Bun](https://bun.sh/) (workspace package manager and runtime)
2. Product host tools from the product README: `git`, plus `gh` for GitHub
   Repositories and `glab` for GitLab Repositories. Authenticate each Forge CLI
   for the Repository's Forge Host.
3. The selected Agent Backend on PATH (`opencode` by default), authenticated per
   its own documentation.
4. Optional: `keymaxxer` on PATH, or `KEYMAXXER_ENTRYPOINT` pointing at an
   existing entrypoint (no hardcoded machine path). Not used by Grok Build
   Agent Turns.
5. Contributor scripts only: `curl`, used by GitLab e2e and fixture scripts
   such as `scripts/setup-gitlab-e2e-fixture.sh` and
   `scripts/regenerate-e2e-keymaxxer-vault.sh`. It is not required to run the
   operator binary.

## Install

```bash
git clone git@github.com:berenddeboer/ready-for-agent.git
cd ready-for-agent
bun install
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

Or with non-standard ports / bind host (`HOST` / `ready-for-agent start --host`,
same semantics as Vite `server.host`; Sidecar is unchanged):

```
PORT=4021 KEYMAXXER_SIDECAR_PORT=4031 bunx nx run harness:dev
HOST=0.0.0.0 bunx nx run harness:dev
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
