# @ready-for-agent/cli

CLI for the ready-for-agent harness.

## Usage

Start the GraphQL API and harness from the repo root:

```bash
bun run --cwd apps/api dev
# In another terminal:
bun run --cwd apps/harness dev
```

Then add a local repository:

```bash
bun run harness-cli add /path/to/local/repo
```

The CLI inspects the local git repository, calls the harness GraphQL endpoint at `http://127.0.0.1:4200/graphql`, and prints the returned Repository fields. The API currently returns a stub response; persistence is not wired yet. The path must be a git repository with a GitHub remote, and new Repositories are reported as paused.

Override the endpoint when the harness is available elsewhere:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:3001/graphql \
  bun run harness-cli add /path/to/local/repo
```

Example:

```bash
bun run harness-cli add ~/src/pf/monorepo/
# Added repository processfocus/monorepo
#   id: stub-repository-id
#   local path: /home/berend/src/pf/monorepo
#   bare: true
#   paused: true
```

```bash
bun run harness-cli --help
bun run harness-cli add --help
```
