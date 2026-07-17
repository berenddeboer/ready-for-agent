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
(`harness:dev`), including the Keymaxxer sidecar when available.

Before start, the binary checks that required host tools are on `PATH`: `git`,
`gh`, and OpenCode. Missing tools fail immediately with install hints. Keymaxxer
is optional; ambient GitHub auth still works without it.

On successful start the default browser opens to the local UI
(`http://127.0.0.1:4200/` by default). Disable with:

```bash
bun run ready-for-agent --no-open
# or
NO_BROWSER=1 bun run ready-for-agent
```

### Application data

By default, product state is stored under the platform data directory:

- Linux: `$XDG_DATA_HOME/ready-for-agent/` or `~/.local/share/ready-for-agent/`
- macOS: `~/Library/Application Support/ready-for-agent/`

The SQLite database file is `ready-for-agent.db` in that directory. Set
`SQLITE_DATABASE_PATH` to use another SQLite/Turso database (this still overrides
the product default). Monorepo `nx run harness:dev` may still default to
`tmp/ready-for-agent.db` when started without the operator binary and without
`SQLITE_DATABASE_PATH`.

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
bun run ready-for-agent start --help
bun run ready-for-agent add --help
bun run ready-for-agent remove-github-token --help
```
