# Contributing

Operator install and run instructions live in [README.md](README.md). This file
covers monorepo development of Ready for Agent.

## Prerequisites

- [Bun](https://bun.sh/) (workspace package manager and runtime)
- Host tools from the product README: `git`, `gh`, OpenCode on PATH
- Optional: `keymaxxer` on PATH, or `KEYMAXXER_ENTRYPOINT` pointing at an
  existing entrypoint (no hardcoded machine path)

Workspace `package.json` pins `keymaxxer@0.2.1` for live e2e vault tooling only;
that pin is not a product install requirement.

## Setup

```bash
git clone git@github.com:berenddeboer/ready-for-agent.git
cd ready-for-agent
bun install
```

## Run the Harness (monorepo)

Preferred operator-shaped entry from the repo root:

```bash
bun run ready-for-agent
# or
bun run ready-for-agent start
```

That boots the full Harness (UI + backend) on the monorepo dev path
(`harness:dev`), including the Keymaxxer sidecar when available.

Equivalent Nx target:

```bash
bunx nx run harness:dev
```

- UI: `http://127.0.0.1:4200`
- GraphQL: `http://127.0.0.1:4200/graphql`
- Sidecar (dev): `127.0.0.1:5032` (preserves Keymaxxer session across reloads)

Operator subcommands against a running Harness:

```bash
bun run ready-for-agent add /path/to/local/repo
bun run ready-for-agent remove-github-token owner/repository
```

Non-default GraphQL URL:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:4300/graphql \
  bun run ready-for-agent add /path/to/local/repo
```

Disable browser open:

```bash
bun run ready-for-agent --no-open
# or
NO_BROWSER=1 bun run ready-for-agent
```

### Database defaults in development

| How you start | Default DB when `SQLITE_DATABASE_PATH` is unset |
| --- | --- |
| Operator binary (`bun run ready-for-agent`) | Platform data dir (`~/.local/share/ready-for-agent/` on Linux, Application Support on macOS), file `ready-for-agent.db` |
| `bunx nx run harness:dev` / `harness:start` | `tmp/ready-for-agent.db` |

`SQLITE_DATABASE_PATH` always overrides. Fully stop the harness before opening
the file with external write tooling (single-process WAL).

## Production-style monorepo start

```bash
bunx nx run harness:start
```

Production lifecycle in `apps/harness/server.ts` owns migrations, Keymaxxer
Sidecar coordination, HTTP listen, and browser open. Opens the browser unless
`NO_BROWSER` or `--no-open` is set.

## Quality checks

Prefer Nx from the workspace package manager:

```bash
bunx nx run-many -t test,lint,typecheck
bunx nx run <project>:test
bun run lint
bun run knip
```

See [AGENTS.md](AGENTS.md) for agent-oriented conventions (Nx, Effect, issue
tracker).

## Package layout

- Public product surface: `apps/ready-for-agent` (unified binary: `start`,
  `add`, `remove-github-token`)
- Harness UI + backend: `apps/harness`
- Keymaxxer sidecar: `apps/keymaxxer-sidecar`
- Internal libraries: `packages/*` (remain private / unpublished)

Platform packages for the published binary are described in
[docs/adr/0023-public-npm-binary-distribution.md](docs/adr/0023-public-npm-binary-distribution.md).
Release process:
[docs/adr/0024-manual-oidc-npm-release.md](docs/adr/0024-manual-oidc-npm-release.md).

### Cutting a release

Releases are **manual only** (`workflow_dispatch` on `.github/workflows/ci-cd.yml`).
PR and `push` to `main` stay quality gates (lint, knip, test, typecheck) and never
publish.

1. One-time human setup on npm: configure Trusted Publishing (OIDC) for
   `ready-for-agent` and each platform package, pointing at this repository and
   workflow file.
2. From GitHub Actions, run the **CI/CD** workflow via **Run workflow**.
3. The release job requires the host **packed-install** smoke (pack + install
   outside the checkout, no Bun/Nx on product PATH) plus main quality gates,
   computes the next version from conventional commits (fails if nothing to
   release), builds multi-platform binaries, re-runs packed-install against the
   versioned host binary, publishes with OIDC + provenance, tags `vX.Y.Z`, and
   creates a GitHub Release with notes and binaries.

Local helpers (no publish):

```bash
bunx nx run release-versioning:compute-next-version
bun --conditions @ready-for-agent/source \
  packages/release-versioning/src/bin/apply-publish-versions.ts 0.1.0 --for-publish
```

`--for-publish` also stages npm READMEs: the root product [README.md](README.md)
into `apps/ready-for-agent/` (so the npm page is install/usage, not monorepo
architecture notes), and a shared platform-binary stub into each
`packages/ready-for-agent-*` package.

## Live end-to-end fixture

The private End-to-End Fixture Repository
`berenddeboer/test-ready-for-agent` and the checked-in encrypted Keymaxxer vault
under `e2e/fixtures/keymaxxer/` support live Harness e2e runs. See
[docs/e2e-fixture.md](docs/e2e-fixture.md) for the sentinel Issue contract,
token rotation, and vault regeneration
(`scripts/regenerate-e2e-keymaxxer-vault.sh`). The master key is never
committed; CI uses `E2E_KEYMAXXER_MASTER_KEY`.

```bash
bunx nx run harness:e2e
```

## Further reading

- [README.md](README.md) — operator install and usage
- [ARCHITECTURE.md](ARCHITECTURE.md) — design notes
- [CONTEXT.md](CONTEXT.md) — domain language
- [apps/harness/README.md](apps/harness/README.md) — harness-specific notes
- [apps/ready-for-agent/README.md](apps/ready-for-agent/README.md) — binary package notes
