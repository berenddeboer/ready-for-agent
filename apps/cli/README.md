# @ready-for-agent/cli

CLI for the ready-for-agent harness.

## Usage

From the repo root:

```bash
bun run harness-cli add /path/to/local/repo
```

Inspects a local git repository and prints the harness Repository fields (owner/repo, path, bare, paused). Persistence is not wired yet. The path must be a git repo with a GitHub remote; new repositories are reported as paused.

Example:

```bash
bun run harness-cli add ~/src/pf/monorepo/
# Added repository processfocus/monorepo
#   local path: /home/berend/src/pf/monorepo
#   bare: true
#   paused: true
```

```bash
bun run harness-cli --help
bun run harness-cli add --help
```
