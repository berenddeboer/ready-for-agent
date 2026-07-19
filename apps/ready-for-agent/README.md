# ready-for-agent (monorepo)

Unified operator binary for Ready for Agent: start the Harness and run operator
commands against its GraphQL endpoint.

**npm package README:** the published `ready-for-agent` package ships the
repository root [README.md](../../README.md) (install and usage). Release
staging (`apply-publish-versions --for-publish`) copies that file over this one
for the npm tarball. Keep monorepo / package-shape notes here for contributors.

Monorepo development: [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Public package shape

The publishable launcher is this package (`ready-for-agent`) with a Node-compatible
bin that selects the host platform binary from optional dependencies:

- `ready-for-agent-linux-x64`
- `ready-for-agent-linux-arm64`
- `ready-for-agent-darwin-x64`
- `ready-for-agent-darwin-arm64`

Compile a host binary into the matching platform package (depends on
`harness:build` and embeds UI assets, GraphQL schema, and migrations):

```bash
bunx nx run ready-for-agent:compile
# or a specific platform key:
bunx nx run ready-for-agent:compile --args=--platform=linux-x64
```

The compiled binary boots the production Harness in-process (no monorepo, Nx,
Vite, or external Bun). With Keymaxxer unavailable or `KEYMAXXER_ENABLED=false`,
it uses ambient GitHub authentication.

Then the launcher runs that binary without Bun on `PATH`:

```bash
node apps/ready-for-agent/bin/ready-for-agent.js --help
```

Unsupported platforms (including Windows in v1) exit with a clear error from the
platform-selection seam (`bin/select-platform.js`).

Internal `@ready-for-agent/*` workspace packages stay private and are not published.

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
is optional (`KEYMAXXER_ENTRYPOINT` or `keymaxxer` on PATH); ambient GitHub auth
still works without it.

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

Token deletion is a Keymaxxer CLI operation, not an operator binary command:

```bash
keymaxxer rm <SECRET_NAME>
```

After deletion, reload the Harness so it detects the missing credential and
offers the existing Create GitHub token / Store in Keymaxxer flow.

### Help

```bash
bun run ready-for-agent --help
bun run ready-for-agent start --help
bun run ready-for-agent add --help
```
