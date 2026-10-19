# Contributing

Operator install and run instructions live in [README.md](README.md). This file
covers monorepo development of Ready for Agent.

# Getting started

## Prerequisites

Product host tools from the product README: `git`, plus `gh` for GitHub
Repositories, `glab` for GitLab Repositories, and `AZURE_DEVOPS_EXT_PAT` for
Azure DevOps Repositories. Authenticate each Forge CLI for the Repository's
Forge Host.

Also needed to run or test the harness:

1. The selected Agent Backend on PATH. The default is OpenCode 2 (`opencode`);
   OpenCode 1 is not supported. Authenticate it per its own documentation.
2. Optional: `keymaxxer` on PATH, or `KEYMAXXER_ENTRYPOINT` pointing at an
   existing entrypoint (no hardcoded machine path). Not used by Grok Build
   Agent Turns.
3. Contributor scripts only: `curl`, used by GitLab e2e and fixture scripts
   such as `scripts/setup-gitlab-e2e-fixture.sh` and
   `scripts/regenerate-e2e-keymaxxer-vault.sh`. It is not required to run the
   operator binary.

## Install with mise

[mise](https://mise.jdx.dev/) 2026.7.0 or later installs the pinned Bun, hk,
Usage (5.1.0), and jactionlint (2.2.0) versions, then workspace dependencies
(which apply the existing Git hooks).

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
`5.1.0` on `PATH`. Workflow checks need jactionlint `2.2.0` on `PATH`
(the version pinned in `mise.toml`). Then:

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

## Releases and breaking changes

Releases are published only by manually dispatching the **CI/CD** workflow
from `main`, after the release PR has merged. The workflow computes the
version from conventional commits since the last release tag; do not bump
the placeholder package versions by hand.

A breaking-change commit advances the major version even on `0.x`. For the
OpenCode 2 requirement, merging the following title and footer makes the
next release after `0.33.1` **1.0.0**:

```text
docs(opencode)!: require OpenCode 2 for the 1.0 release

BREAKING CHANGE: The OpenCode backend requires OpenCode 2. OpenCode 1 is no longer supported. Upgrade the CLI and any explicitly configured OpenCode server before using this backend.
```

Keep the `!` in the PR title and the `BREAKING CHANGE:` footer in its body
when squash-merging: the repository uses the PR title and body for the
squash commit, and release analysis reads commits on `main`, not PR labels.
Update the operator upgrade guidance for every breaking change. See
[the release decision](docs/adr/0024-manual-oidc-npm-release.md) for the
publication and validation policy.

## GitHub Actions workflow check

[jactionlint](https://github.com/jdx/jactionlint) `2.2.0`, the version pinned
in [`mise.toml`](mise.toml), checks `.github/workflows/`, local composite
actions under `.github/actions/`, and `.github/dependabot.yml` with the
default profile. Pull-request and main-branch CI download that same release,
verify its checksum and GitHub artifact attestation, and run:

```bash
jactionlint --format github
```

After `mise install`, run that same command locally. `jactionlint` without
`--format github` reports the same findings as text. Ubuntu runners include
`shellcheck`, which jactionlint uses for `run:` scripts; install shellcheck
locally to see those script findings too.

Intentional exceptions are listed with their reasons in
[`.github/jactionlint.yaml`](.github/jactionlint.yaml). Pinact remains a
separate check.

## Operator CLI Usage contract

The CI Usage quality gate is one command:

```bash
bunx nx run ready-for-agent:check-usage
```

That target lints the KDL contract, compares the public Effect CLI
inventory, checks generated command-reference drift without rewriting the worktree,
and verifies Usage completion behavior. It is the same gate pull-request
and main-branch quality workflows run when `ready-for-agent` is affected.

## Operator CLI command reference

The public [command reference](docs/command-reference.md) is generated from the Usage contract
in `apps/ready-for-agent/ready-for-agent.usage.kdl` with the pinned Usage
CLI (`5.1.0`). After changing that contract, refresh only the managed
command-reference section:

```bash
bunx nx run ready-for-agent:update-usage-docs
```

Ordinary validation generates into temporary storage and byte-compares
the checked-in section without rewriting the worktree:

```bash
bunx nx run ready-for-agent:check-usage-docs
```

`bunx nx run ready-for-agent:test` runs `check-usage` first.

## Usage shell completions

Operators who install Usage can generate richer completions from
`ready-for-agent --usage`. The Nx target prints an on-demand script for
one Usage-supported shell (bash, zsh, fish, nu, powershell). Generation
embeds `ready-for-agent --usage` as the spec command; it does not read
the source-tree KDL path. **Usage v5.1.0 is a runtime dependency** of
the generated scripts.

```bash
bunx nx run ready-for-agent:generate-usage-completions --args="--shell=bash"
bunx nx run ready-for-agent:generate-usage-completions --args="--shell=zsh"
bunx nx run ready-for-agent:generate-usage-completions --args="--shell=fish"
bunx nx run ready-for-agent:generate-usage-completions --args="--shell=nu"
bunx nx run ready-for-agent:generate-usage-completions --args="--shell=powershell"
```

Do not check the generated scripts into the repository or ship them in
platform packages. Users who do not install Usage keep
`ready-for-agent --completions`.

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

## Manually editing a Work Item's worktree

Resolving a merge conflict or applying a hotfix by hand in a Work Item's
worktree while the harness could still resume driving it? Follow
[docs/manual-worktree-edits.md](docs/manual-worktree-edits.md) first: check
`hasActiveStepRun`, Pause Work Item, and Interrupt Work Item if a Step Run is
still running, before you start editing.

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
