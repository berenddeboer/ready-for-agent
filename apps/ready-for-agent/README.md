# ready-for-agent

Unified operator binary for Ready for Agent: start the Harness and run operator
commands against its GraphQL endpoint.

## Usage (monorepo)

From the repository root:

```bash
bun run ready-for-agent
# or
bun run ready-for-agent start
```

This boots the full Harness (UI + backend) on the existing monorepo dev path
(`harness:dev`), including the Keymaxxer sidecar. By default, application data
is stored in `tmp/ready-for-agent.db`. Set `SQLITE_DATABASE_PATH` to use another
SQLite/Turso database.

Stop the harness completely before opening that database with external write
tooling (CLI, GUI, or a second process). The harness uses single-process default
WAL; concurrent writers are not supported.

### Add a repository

With the Harness running:

```bash
bun run ready-for-agent add /path/to/local/repo
```

The command inspects the local git repository, calls the harness GraphQL
endpoint at `http://127.0.0.1:4200/graphql`, and prints the persisted Repository
fields. The path must be a git repository with a GitHub remote, and new
Repositories are reported as paused.

Override the endpoint when the harness is available elsewhere:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:4300/graphql \
  bun run ready-for-agent add /path/to/local/repo
```

If the GraphQL endpoint is unreachable, the command fails with a clear hint to
start the Harness first.

### Remove a GitHub token

```bash
bun run ready-for-agent remove-github-token /path/to/local/repo
bun run ready-for-agent remove-github-token owner/repository
bun run ready-for-agent remove-github-token repo-01H...
```

### Help

```bash
bun run ready-for-agent --help
bun run ready-for-agent add --help
bun run ready-for-agent remove-github-token --help
```
