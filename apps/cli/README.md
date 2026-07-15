# @ready-for-agent/cli

CLI for the ready-for-agent harness.

## Usage

Start the harness from the repo root:

```bash
bun nx run harness:dev
```

This starts one TanStack Start application server for both the SPA and GraphQL,
plus the development-only Keymaxxer sidecar. By default, application data is
stored in `tmp/ready-for-agent.db`. Set `SQLITE_DATABASE_PATH` to use another
SQLite/Turso database.

Then add a local repository:

```bash
bun run harness-cli add /path/to/local/repo
```

The CLI inspects the local git repository, calls the harness GraphQL endpoint at `http://127.0.0.1:4200/graphql`, and prints the persisted Repository fields. The path must be a git repository with a GitHub remote, and new Repositories are reported as paused.

Override the endpoint when the harness is available elsewhere:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:4200/graphql \
  bun run harness-cli add /path/to/local/repo
```

Example:

```bash
bun run harness-cli add ~/src/pf/monorepo/
# Added repository processfocus/monorepo
#   id: repo-01...
#   local path: /home/berend/src/pf/monorepo
#   bare: true
#   paused: true
```

Remove a repository GitHub token by local path, GitHub `owner/repository`, or
repository id:

```bash
bun run harness-cli remove-github-token /path/to/local/repo
bun run harness-cli remove-github-token processfocus/monorepo
bun run harness-cli remove-github-token repo-01H...
```

Example:

```bash
bun run harness-cli remove-github-token ~/src/pf/monorepo/
# Removed GitHub token for processfocus/monorepo
#   secret: GITHUB_TOKEN_PROCESSFOCUS_MONOREPO

bun run harness-cli remove-github-token processfocus/monorepo
# Removed GitHub token for processfocus/monorepo
#   secret: GITHUB_TOKEN_PROCESSFOCUS_MONOREPO

bun run harness-cli remove-github-token repo-01H...
# Removed GitHub token for processfocus/monorepo
#   secret: GITHUB_TOKEN_PROCESSFOCUS_MONOREPO
```

```bash
bun run harness-cli --help
bun run harness-cli add --help
bun run harness-cli remove-github-token --help
```
