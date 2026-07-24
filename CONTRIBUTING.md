# Contributing

Operator install and run instructions live in [README.md](README.md). This file
covers monorepo development of Ready for Agent.

# Getting started

## Prerequisites

1. [Bun](https://bun.sh/) (workspace package manager and runtime)
2. Host tools from the product README: `git`, `gh`, and the selected Agent
   Backend on PATH (`opencode` by default; `grok` when developing against Grok
   Build). Authenticate Grok with `grok login` or `XAI_API_KEY` for live runs.
3. Optional: `keymaxxer` on PATH, or `KEYMAXXER_ENTRYPOINT` pointing at an
  existing entrypoint (no hardcoded machine path). Not used by Grok Build
  Agent Turns.

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
- Sidecar (dev): `127.0.0.1:6057` (preserves Keymaxxer session across reloads)

Or with non-standard ports:

```
PORT=4021 KEYMAXXER_SIDECAR_PORT=4031 bunx nx run harness:dev
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

This repo is an [Nx monorepo](https://nx.dev/). Your agent will now
how to deal with this.

Architecture notes are in
[ARCHITECTURE.md](ARCHITECTURE.md) and domain language in
[CONTEXT.md](CONTEXT.md).
