# Ready for Agent

Opinionated agentic software engineering harness that works GitHub issues into
PRs for configured repositories.

## Install

Requires a supported platform (Linux or macOS, x64 or arm64). Windows is not
supported in v1.

```bash
npx ready-for-agent@latest
```

Or install the package and use the `ready-for-agent` command:

```bash
npm install -g ready-for-agent
ready-for-agent
```

You do not need Bun on PATH; the package ships a compiled binary for your host.

## Start

Default command (and `start`) boots the full Harness (UI + backend) on loopback:

```bash
ready-for-agent
# same as
ready-for-agent start
```

- UI: `http://127.0.0.1:6056/`
- GraphQL: `http://127.0.0.1:6056/graphql`

On successful start the default browser opens to the UI. Disable with:

```bash
ready-for-agent --no-open
# or
NO_BROWSER=1 ready-for-agent
```

Use different Harness and Keymaxxer Sidecar ports when needed:

```bash
# Harness on a non-default port
PORT=7000 ready-for-agent

# Point CLI commands at that harness
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:7000/graphql \
  ready-for-agent add /path/to/local/repo

# Keymaxxer Sidecar on a non-default port
KEYMAXXER_SIDECAR_PORT=7001 ready-for-agent
```

### Application data

Product state defaults to the platform data directory:

- Linux: `$XDG_DATA_HOME/ready-for-agent/` or `~/.local/share/ready-for-agent/`
- macOS: `~/Library/Application Support/ready-for-agent/`

The SQLite database is `ready-for-agent.db` in that directory. Set
`SQLITE_DATABASE_PATH` to use another file. Stop the harness completely before
opening the database with external write tooling (single-writer SQLite).

## Add a repository

With the Harness running, register a local checkout that has a GitHub remote:

```bash
ready-for-agent add /path/to/local/repo
```

New repositories start **paused**. Unpause in the UI when you want autonomous
work. Issues labeled `ready-for-agent` appear after reconciliation.

If GraphQL is unreachable, the command fails with a hint to start the Harness
first. Point at a non-default endpoint with:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:7000/graphql \
  ready-for-agent add /path/to/local/repo
```

### Other commands

```bash
ready-for-agent --help
ready-for-agent start --help
ready-for-agent add --help
```

To delete a stored GitHub token, use the Keymaxxer CLI (`keymaxxer rm <SECRET_NAME>`), then reload the Harness so it detects the missing credential.

## Requirements

**Required on PATH** (start fails fast if missing):

1. [git](https://git-scm.com/)
2. [GitHub CLI (`gh`)](https://cli.github.com/)
3. [OpenCode](https://opencode.ai)

**Optional:**

4. [keymaxxer](https://github.com/glommer/keymaxxer) — vault-backed secrets.
   Resolved as `KEYMAXXER_ENTRYPOINT` when set to an existing path, otherwise
   the `keymaxxer` command on PATH. When neither is available, the harness uses
   ambient GitHub authentication. Set `KEYMAXXER_ENABLED=false` to force that
   mode.

Also assume:

- You use GitHub.
- Local checkouts for repositories you add are set up for development.
- Ideally AI code review runs via GitHub Actions on those repositories.

## How it works

1. You install and start the Harness, then `ready-for-agent add` a local repo.
2. Ready-labeled issues (`ready-for-agent`) show up after reconciliation.
3. You implement a single issue from the UI to start.

For each Work Item the harness creates a worktree and branch, implements the
issue, runs a local review, and opens a draft PR. It watches status checks,
addresses review comments, marks the PR ready for review, then either
auto-merges low-risk changes or asks a human.

GitHub issues remain the source of truth; the local database is book-keeping.
Style and guidelines come from the target repository—this harness steers an
agent swarm on Ready-labeled work.

## Contributing

Monorepo setup, Nx targets, and development workflow live in
[CONTRIBUTING.md](CONTRIBUTING.md). Architecture notes are in
[ARCHITECTURE.md](ARCHITECTURE.md) and domain language in
[CONTEXT.md](CONTEXT.md).
