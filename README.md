# Ready for Agent: Clanker Harness for 150+ PRs a week

This harness is designed for people who create issues in GitHub, and
then use this tool to start working working on them, reviewing them,
and merging them (if auto-merge is enabled). It's a different way of
working: you talk to your agent to create GitHub issues, and this
harness implements them.

Label your issues with `ready-for-agent`, then select an issue in the
UI to start working on it, or select a parent to implement all child
issues.

It very much supports a HITL workflow (Human in the Loop): you design,
you architect, you verify where needed.

It works very well if you follow [the Matt Pocock
workflow](https://www.youtube.com/watch?v=M6mYodf0dJM): start a
grilling session, then create a specification (`/to-spec`), then
create tickets (`/to-tickets1`). These tickets will be labled with
ready-for-agent, and show up immediately. Install his [Skills for Real Engineers](https://github.com/mattpocock/skills) to get started with this
workflow.

<img src="ready-for-agent.png" alt="Ready for Agent" width="90%" />

## How it works

The harness creates a new worktree, installs packages, and asking a
selectable headless Agent Backend ([OpenCode](https://opencode.ai/),
[Codex](https://github.com/openai/codex), or [Grok
Build](https://docs.x.ai/)) to implement the issue, review the issue,
create a PR, and merge if allowed.

The goal of this clanker harness is to get you to that 25+ PRs merged
a day nirvana. It does that by removing the time spend babysitting an
agent sand guiding it through a implement, review, commit, and watch
PR stages.

See [the introduction
video](https://www.youtube.com/watch?v=dnYWUenIo7Y) to see the tool in
action.

# Usage

Requires a supported platform: Linux, macOS, or Windows (x64 or arm64).

Run:

```bash
npx ready-for-agent@latest
```

Or install the package and use the `ready-for-agent` command:

```bash
npm install -g ready-for-agent
ready-for-agent
```

This opens the UI in the browser
([http://127.0.0.1:6056/](http://127.0.0.1:6056/)). This shows the
configured state. If you open this for the first time, you will be
prompted to set a default build model and effort (thinking), and configure repos.

## Stop opening a browser window

Disable opening a browser window with:

```bash
ready-for-agent --no-open
# or
NO_BROWSER=1 ready-for-agent
```

## Use a different port

Use a different port than 6056:

```bash
PORT=7000 ready-for-agent
```

## Configuring a repo

If you open ready-for-agent without any repo configured, it will prompt. Add with:

```bash
ready-for-agent add /path/to/local/repo
```

If you use a non-default port:

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:7000/graphql \
  ready-for-agent add /path/to/local/repo
```

## Working on issues

Currently the harness does not automatically pick issues to work
on. Click on the kebab menu and implement this end to end via
"Implement now".

You can configure your repo to automatically merge the PR. Default is
for human review to take place. If auto-merge is enabled, the harness
will ask the AI about the risk of auto-merge. Only low risk PRs are
auto-merged, higher risk still require human review.

Pick the "Implement locally" option to implement the issue in the new
worktree, but withoutr creating a PR yet. This allows you to test and verify.

## Assumptions

- You use GitHub or GitLab.
- You have a repo cloned locally, either "normally" or as a bare clone
  (recommended). Install the [git-bare-worktree
  skill](https://github.com/berenddeboer/git-bare-worktree) and let
  your agent create this setup for you: `npx skills@latest add
  berenddeboer/git-bare-worktree --global`
- The harness is designed to run on your local laptop. This avoids
  cloud costs, and you already paid for an extensive
  machine. Secondly, your machine will be setup for your repo, so we
  avoid the setup issues you get with running compute in the cloud.
- Ideally you have setup a CI pipeline with automated build/test and an AI code review.

# Requirements

**Always required on PATH** (start fails fast if missing):

1. [git](https://git-scm.com/)

**Forge-specific tools** (required only when at least one Repository uses that
Forge):

2. [GitHub CLI (`gh`)](https://cli.github.com/) for GitHub Repositories
3. [curl](https://curl.se/) for GitLab Repositories. `glab` is an optional
   ambient credential source, not a required host tool.

**Agent Backend executable** (only the backend selected in Settings is
required; default is OpenCode):

4. [OpenCode](https://opencode.ai/) (`opencode` on PATH) when OpenCode is the
   selected Agent Backend
5. [Codex](https://github.com/openai/codex) (`codex` on PATH) when Codex is the
   selected Agent Backend
6. [Grok Build](https://docs.x.ai/) (`grok` on PATH) when Grok Build is the
   selected Agent Backend

Authenticate Grok Build with `grok login` or `XAI_API_KEY` before Recheck /
Agent Turns. Harness-launched Grok processes disable auto-update for that
session (`--no-auto-update` / `GROK_DISABLE_AUTOUPDATER`). Grok Build Agent
Turns do not integrate Keymaxxer; Session Telemetry is live-read from on-disk
Grok session files under `$GROK_HOME/sessions` (default `~/.grok`). Opt-in live
adapter tests use `GROK_INTEGRATION=1` / `OPENCODE_INTEGRATION=1` /
`CODEX_INTEGRATION=1`; normal CI does not need paid model credentials.

**Optional:**

7. [keymaxxer](https://github.com/glommer/keymaxxer) — vault-backed secrets for
   Harness-owned GitHub operations and GitHub or GitLab OpenCode Agent Turns.
   Resolved as `KEYMAXXER_ENTRYPOINT` when set to an existing path, otherwise
   the `keymaxxer` command on PATH. When neither is available, the harness uses
   ambient Forge authentication. Set `KEYMAXXER_ENABLED=false` to force that
   mode. Grok Build Agent Turns always use ambient Forge authentication and do
   not configure Keymaxxer MCP.

# KeyMaxxer

Ready for Agent supports
[keymaxxer](https://github.com/glommer/keymaxxer), but does not
require it. With KeyMaxxer secrets stay encrypted, and are only
granted to agents when they need them.

Keymaxxer is automatically enabled if keymaxxer is in your path. Disable with:

```
KEYMAXXER_ENABLED=false npx ready-for-agent@latest
```

# Frequently Asked Questions

1. Is there support for agents other than OpenCode?

Yes. Settings can select [OpenCode](https://opencode.ai/),
[Codex](https://github.com/openai/codex), or [Grok Build](https://docs.x.ai/) as
the instance-wide Agent Backend. The change hot-activates on Save when no Work
Items are unfinished (including Needs Human). Model catalogs and effort
(thinking) options are backend-local, and build/review prefs are remembered per
backend.

2. Does the harness support a Forge other than GitHub?

Yes. GitLab Repository identity, Issue reconciliation, and local Agent Turns
through Review are supported. GitLab Pull Request lifecycle operations are
being delivered in later phases.

3. Can I implement something locally, and then check myself?

Yes, pick "Implement locally" from the kebab menu. Everything stays
local, and no commit is made.

# Architecture

## The Forge is source of truth

Issues on the configured Repository Forge (GitHub/GitLab) remain the
source of truth; the local database is book-keeping. Style and
guidelines come from the target repository—this harness steers an
agent swarm on `ready-for-agent` labeled work.

## Graphql API

The backend is served as graphql api: `http://127.0.0.1:6056/graphql`

## Application data

Product state defaults to the platform data directory:

- Linux: `$XDG_DATA_HOME/ready-for-agent/` or `~/.local/share/ready-for-agent/`
- macOS: `~/Library/Application Support/ready-for-agent/`

The SQLite database is `ready-for-agent.db` in that directory. Set
`SQLITE_DATABASE_PATH` to use another file. Stop the harness completely before
opening the database with external write tooling (single-writer SQLite).

## Contributing

Contributions welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).
