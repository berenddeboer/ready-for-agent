# Ready for Agent: Clanker Harness for 150+ PRs a week

Ready for Agent turns GitHub, GitLab, or Azure DevOps issues into
merged pull requests. You mark them `ready-for-agent` (a label on
GitHub and GitLab, a Boards tag on Azure DevOps). The harness hands
each one to your preferred coding agent, which implements it, reviews
the code, opens a PR, and merges when allowed. You design, you
architect, you verify where needed — the harness removes the
babysitting between issue and merged PR.

<img src="ready-for-agent.png" alt="Ready for Agent" width="90%" />

Watch [the introduction
video](https://www.youtube.com/watch?v=TK1OeQZswiQ) to see the tool in
action.

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Forge token scopes](docs/forge-token-scopes.md)
- [Features](#features)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Azure DevOps](#azure-devops)
- [Command reference](#command-reference)
- [Shell completions](#shell-completions)
- [Troubleshooting](#troubleshooting)
- [Frequently Asked Questions](#frequently-asked-questions)
- [Glossary](#glossary)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)
- [Related work](#related-work)

## Quick start

1. Install the [prerequisites](#requirements) and have them on your PATH:
   [git](https://git-scm.com/), the [GitHub CLI
   (`gh`)](https://cli.github.com/), and at least one coding agent —
   [OpenCode](https://opencode.ai/),
   [Codex](https://github.com/openai/codex), [Grok
   Build](https://docs.x.ai/), or [Claude
   Code](https://docs.anthropic.com/en/docs/claude-code) —
   authenticated per its own documentation.
2. Start the harness:

   ```bash
   npx ready-for-agent@latest
   ```

   Or install it once with `npm install -g ready-for-agent` and run
   `ready-for-agent`. The UI opens at
   [http://127.0.0.1:6056/](http://127.0.0.1:6056/). On first run it
   takes you to Settings to pick your coding agent and a default build
   model and effort (thinking).

3. Add a local Git repo from the UI. After start, the blank slate
   prompts you to pick the first repository:

   - Use **Browse…** when shown (Windows, macOS, and typical Linux
     desktops), or paste a host path into the field.
   - Click **Inspect**, confirm the forge identity, then **Confirm and
     add**.

   <img src="docs/add-repository-blank-slate.png" alt="Blank slate: add a repository from the UI (Browse, path field, or CLI)" width="75%" />

   Advanced: once the harness is running, you can also add from a
   shell. The path must be a git repository with a GitHub, GitLab, or
   Azure DevOps remote:

   ```bash
   ready-for-agent add /path/to/local/repo
   ```

4. Mark a Ready Issue: label a GitHub or GitLab issue
   `ready-for-agent`, or tag an Azure Boards work item
   `ready-for-agent`. It shows up in the UI shortly. By default only
   issues you authored are listed — see
   [Troubleshooting](#troubleshooting). Azure specifics (PAT, empty
   repos, Merge Policy) are in [Azure DevOps](#azure-devops).

5. Go to the `/repos` page to see your issues:

<img src="docs/repos-page.png" alt="Ready for Agent repos" width="90%" />

6. Click the **implement** button to run it end to end — implement,
   review, PR

<img src="docs/repos-implement-button.png" alt="Ready for Agent implement issue button" width="90%" />

   Alternatively you can open the issue's kebab menu and pick **Implement
   locally** to stop before the PR and inspect the work yourself.

<img src="docs/repos-implement-locally.png" alt="Ready for Agent implement locally menu" width="90%" />

## Requirements

A supported platform: Linux, macOS, or Windows (x64 or arm64).

**Always required on PATH** (start fails fast if missing):

- [git](https://git-scm.com/)

**Forge-specific tools** (required only when at least one repository
uses that Forge):

- [GitHub CLI (`gh`)](https://cli.github.com/) for GitHub repositories
- [GitLab CLI (`glab`)](https://docs.gitlab.com/cli/) for GitLab repositories.
  Authenticate `glab` for each repository's Forge Host.
- Azure DevOps: no CLI. Set `AZURE_DEVOPS_EXT_PAT` to a personal
  access token. See [Azure DevOps](#azure-devops) and the
  [token scopes ticket](https://github.com/berenddeboer/ready-for-agent/issues/1213).

Forge tokens need specific scopes for poll, push, Create PR, Watch,
Merge PR, and close-out. Azure DevOps in particular: git push and
Create PR can succeed with a narrower PAT than Merge PR — that split
is how a “working” token still fails every ticket at merge. See
[Forge token scopes](docs/forge-token-scopes.md).

**Coding agents** are soft prerequisites: they are inspected after
the harness starts and never block the process or UI from starting. A
missing or broken selected backend (default is OpenCode) is shown as
**Agent Backend Unavailable**; open Settings to choose another
backend, reinstall the CLI, or use Recheck after fixing it:

- [OpenCode](https://opencode.ai/) (`opencode` on PATH)
- [Codex](https://github.com/openai/codex) (`codex` on PATH)
- [Grok Build](https://docs.x.ai/) (`grok` on PATH)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  (`claude` on PATH)

We assume your coding agent is installed and authenticated — see its
own documentation. To run Claude Code through Amazon Bedrock instead
of a first-party login, see
[docs/claude-code-amazon-bedrock.md](docs/claude-code-amazon-bedrock.md).

You also need:

- A repo cloned locally, either "normally" or as a bare clone
  (recommended). Install the [git-bare-worktree
  skill](https://github.com/berenddeboer/git-bare-worktree) and let
  your agent create this setup for you: `npx skills@latest add
  berenddeboer/git-bare-worktree --global`
- Ideally, a CI pipeline with automated build/test and an AI code
  review.

The harness is designed to run on your local laptop. This avoids
cloud costs — you already paid for an extensive machine — and your
machine is already set up for your repo, so you avoid the setup
issues that come with running compute in the cloud.

## Features

- Four interchangeable coding agents — OpenCode, Codex, Grok Build,
  and Claude Code — switchable instance-wide.
- Per-repo agent and model overrides: expensive models for hard
  repos, cheaper ones for the rest.
- Per-repo Merge Policy: Off (human merge), Classify (risk-assessed
  merge), or Always (skip classify; no CI is green only for Always).
- "Implement locally" to inspect the work before any commit or PR
  exists.
- Select a parent issue and it implements all child issues.
- Optionally include `ready-for-agent` issues created by any author,
  not just issues you created yourself.
- Runs on your laptop against your existing local clone — no cloud
  spend, no environment drift.
- Works with your existing Claude (or other) subscription rather than
  metered API billing.
- GitHub, GitLab, and Azure DevOps support.
- Human in the loop where you want it: you design, you architect, you
  verify.

## How it works

The harness is a loop around issues marked `ready-for-agent` (a GitHub
or GitLab label, or an Azure Boards tag): it only shows those, you
pick the ones to work on, and it autonomously completes them using
your selected coding agent. For each issue it creates a fresh
worktree, installs packages, and asks the headless agent to implement
the issue, review the code, create a PR, and merge if allowed.

Steps 1 to 3 are you. Steps 4 and 5 are the harness.

<img src="docs/way-of-working.png" alt="Way of Working" width="40%" />

The goal of this clanker harness is to get you to that 150+ PRs a
week nirvana. It does that by removing the time spent babysitting an
agent and guiding it through the implementation, review, commit, and
PR status-check stages.

It works very well if you follow [the Matt Pocock
workflow](https://www.youtube.com/watch?v=M6mYodf0dJM): start a
grilling session, create a specification (`/to-spec`), then create
tickets (`/to-tickets`). These tickets will be labeled with
`ready-for-agent`, and show up immediately in the harness. Install his
[Skills for Real Engineers](https://github.com/mattpocock/skills) to
get started with this kind of workflow.

But as long as an issue has the `ready-for-agent` label (or Azure
Boards tag), this tool can work on it.

### Working on issues

Currently the harness does not automatically pick issues to work
on. Click on the kebab menu and implement an issue end to end via
"Implement now".

Each Repository has a Merge Policy. New Repositories start at Off —
a human must merge. Classify runs Decide PR Merge and only low-risk
PRs merge unattended. Always skips Classify and, after the Check-Start
Deadline, treats an absence of CI as green. Pending, failed, and
Expected checks still block.

Pick the "Implement locally" option to implement the issue in the new
worktree, but without creating a PR yet. This allows you to test and
verify before a commit or PR exists.

## Configuration

### Stop opening a browser window

Disable opening a browser window with:

```bash
ready-for-agent --no-open
# or
NO_BROWSER=1 ready-for-agent
```

### Use a different port

Use a different port than 6056:

```bash
PORT=7000 ready-for-agent
```

### Listen on all interfaces (or a specific address)

By default the Harness binds loopback only (`127.0.0.1`). To reach the UI or
GraphQL from another machine, container, or remote desktop, opt in with
Vite-style `--host` / `HOST` (the Keymaxxer Sidecar stays on `127.0.0.1`):

```bash
# all interfaces (0.0.0.0)
ready-for-agent start --host
# or
HOST=0.0.0.0 ready-for-agent start

# a single address
ready-for-agent start --host 192.168.1.10
```

The flag wins when both `--host` and `HOST` are set.

When adding a repo via the CLI against a non-default port or host (Harness must
already be running):

```bash
READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:7000/graphql \
  ready-for-agent add /path/to/local/repo

# non-loopback Harness (use a host/port the CLI machine can reach):
READY_FOR_AGENT_GRAPHQL_URL=http://<reachable-host>:<port>/graphql \
  ready-for-agent add /path/to/local/repo
```

### Per-repo settings

Each repo can override the harness-wide coding agent and build/review
models, and set a Merge Policy (Off, Classify, or Always). This allows
you to configure more expensive models for more complex code, and
cheaper models for others. New Repositories default to Off. For a
no-CI Azure DevOps repo, Always is the unattended merge setting — see
[Azure DevOps](#azure-devops).

### KeyMaxxer

Ready for Agent supports
[keymaxxer](https://github.com/glommer/keymaxxer), but does not
require it. With KeyMaxxer secrets stay encrypted, and are only
granted to agents when they need them.

Keymaxxer is automatically enabled if keymaxxer is in your path.
Disable with:

```bash
KEYMAXXER_ENABLED=false npx ready-for-agent@latest
```

## Azure DevOps

Azure DevOps is a first-class Forge. Ready discovery is a Boards tag
`ready-for-agent`, not a label. Auth is the ambient
`AZURE_DEVOPS_EXT_PAT` environment variable until credential UX
ships. A repo with no default branch is not usable until `main` (or
equivalent) exists. Default Merge Policy is Off; Always is required to
auto-merge a no-CI Azure repo. Boards close-out is not yet at parity
with GitHub and GitLab.

Details: [docs/azure-devops.md](docs/azure-devops.md). Token scopes:
[issue #1213](https://github.com/berenddeboer/ready-for-agent/issues/1213).

## Command reference

<!-- usage:start -->
<!-- @generated by usage-cli from usage spec -->
# `ready-for-agent`

Default invocation (`ready-for-agent`) starts the Harness. It is classified write, matching `start`.

Environment variables (documented here; runtime precedence and semantics are unchanged):

NO_BROWSER
  When set to a non-empty value other than 0, false, no, or off, the default start does not open a browser. The --no-open flag also disables the browser independently of this variable.

HOST
  Listen host for the default start and `start`. The --host flag wins when given. Bare --host binds all IPv4 interfaces (0.0.0.0).

READY_FOR_AGENT_GRAPHQL_URL
  GraphQL endpoint for finite commands (add, candidates, intake, retry, status, jump). Defaults to http://127.0.0.1:6056/graphql. Does not start the Harness.


## Examples

**Default start**

Start the Harness and open the UI

```
ready-for-agent
```

**Start without a browser**

Start the Harness without opening the default browser

```
ready-for-agent start --no-open
```

**Add a Repository**

Inspect a local clone and add it to the running Harness

```
ready-for-agent add /path/to/local/repo
```

**Repository host/path selector**

List Intake Candidates using a forge-host/project-path selector

```
ready-for-agent candidates github.com/owner/repo
```

**Repository host://path selector**

List Intake Candidates using a forge-host://project-path selector

```
ready-for-agent candidates github.com://owner/repo
```

**Repository project-path selector**

List Intake Candidates using a unique project path

```
ready-for-agent candidates owner/repo
```

**Repository final-segment selector**

List Intake Candidates using a unique final project-path segment

```
ready-for-agent candidates repo
```

**Session continuation**

Continue a Work Item Session by opaque backend Session ID

```
ready-for-agent jump 85312e9f-9c57-42ef-9757-b2512cee57cd
```

- **Usage**: `ready-for-agent [FLAGS] <SUBCOMMAND>`

## Global Flags

### `-h --help`

Show help information

### `-v --version`

Show version information

### `--completions <shell>`

Print shell completion script

**Choices:**

- `bash`
- `zsh`
- `fish`
- `sh`

### `--log-level <level>`

Sets the minimum log level

**Choices:**

- `all`
- `trace`
- `debug`
- `info`
- `warn`
- `warning`
- `error`
- `fatal`
- `none`

## Flags

### `--no-open`

Do not open the default browser after a successful start (also: NO_BROWSER)

### `--host [addr]`

Listen host (default 127.0.0.1). Bare --host binds all interfaces (0.0.0.0); --host <addr> binds that address. Env: HOST (flag wins)

**Environment Variable:** `HOST`

## `ready-for-agent start`

- **Usage**: `ready-for-agent start [--no-open] [--host [addr]]`
- **Effect**: modifies state

Start the full Harness (UI + backend); opens the browser unless --no-open / NO_BROWSER

### Flags

#### `--no-open`

Do not open the default browser after a successful start (also: NO_BROWSER)

#### `--host [addr]`

Listen host (default 127.0.0.1). Bare --host binds all interfaces (0.0.0.0); --host <addr> binds that address. Env: HOST (flag wins)

**Environment Variable:** `HOST`

### Examples

**Start**

Start the Harness and open the UI

```
ready-for-agent start
```

**Start on all interfaces**

Bind 0.0.0.0 instead of loopback

```
ready-for-agent start --host
```

## `ready-for-agent add`

- **Usage**: `ready-for-agent add [--forge-host <host>] [--project-path <project-path>] <path>`
- **Effect**: modifies state

Inspect and add a local GitHub, GitLab, or Azure DevOps repository; inferred identity can be corrected with flags

### Arguments

#### `<path>`

Path to a local git repository

### Flags

#### `--forge-host <host>`

Correct the forge host inferred from the repository remote

#### `--project-path <project-path>`

Correct the forge project path inferred from the repository remote

### Examples

**Add**

Add a local git repository

```
ready-for-agent add /path/to/local/repo
```

**Correct inferred identity**

Override the guessed GitLab host and project path

```
ready-for-agent add --forge-host git.drupalcode.org --project-path project/oauth_client /path/to/local/repo
```

## `ready-for-agent candidates`

- **Usage**: `ready-for-agent candidates <repository>`
- **Effect**: read-only

List current Intake Candidates for one Repository as versioned JSON

### Arguments

#### `<repository>`

Repository identity as <forge-host>://<project-path>, <forge-host>/<project-path>, a unique project path, or a unique final project-path segment (case-insensitive)

### Examples

**Candidates**

List Intake Candidates for one Repository

```
ready-for-agent candidates github.com/owner/repo
```

## `ready-for-agent intake`

- **Usage**: `ready-for-agent intake <repository>`
- **Effect**: modifies state

Start every current Intake Candidate for one Repository as versioned JSON

### Arguments

#### `<repository>`

Repository identity as <forge-host>://<project-path>, <forge-host>/<project-path>, a unique project path, or a unique final project-path segment (case-insensitive)

### Examples

**Intake**

Start every current Intake Candidate for one Repository

```
ready-for-agent intake github.com/owner/repo
```

## `ready-for-agent retry`

- **Usage**: `ready-for-agent retry [FLAGS] <repository>`
- **Effect**: modifies state

Retry one Work Item, the unfinished Work Item for one Issue, or every currently retryable Work Item as versioned JSON

### Arguments

#### `<repository>`

Repository identity as <forge-host>://<project-path>, <forge-host>/<project-path>, a unique project path, or a unique final project-path segment (case-insensitive)

### Flags

#### `--issue <number>`

Retry the current unfinished Work Item for this Issue number

#### `--work-item <id>`

Retry this Work Item after verifying it belongs to the selected Repository

#### `--all-retryable`

Retry every currently retryable Work Item in the Repository (Harness-owned canRetry)

#### `--max-autonomous-retries <count>`

Maximum accepted Autonomous Retry execution attempts per Work Item at its current Lifecycle Step (default 3; --all-retryable only)

### Examples

**Retry all retryable**

Retry every currently retryable Work Item in the Repository

```
ready-for-agent retry github.com/owner/repo --all-retryable
```

## `ready-for-agent status`

- **Usage**: `ready-for-agent status [repository]`
- **Effect**: read-only

Print the current six-lane Kanban status as versioned JSON (optional repository selector)

### Arguments

#### `[repository]`

Optional repository identity as <forge-host>://<project-path>, <forge-host>/<project-path>, a unique project path, or a unique final project-path segment (case-insensitive)

### Examples

**Status**

Print Kanban status for every configured Repository

```
ready-for-agent status
```

**Scoped status**

Print Kanban status for one Repository

```
ready-for-agent status github.com/owner/repo
```

## `ready-for-agent jump`

- **Usage**: `ready-for-agent jump <session-id>`
- **Effect**: destructive — may delete or irreversibly overwrite

Continue a Work Item Session (Interactive Session Continuation)

### Arguments

#### `<session-id>`

Opaque backend Session ID to continue

### Examples

**Jump**

Continue the Work Item Session in the current terminal or tmux

```
ready-for-agent jump 85312e9f-9c57-42ef-9757-b2512cee57cd
```
<!-- usage:end -->

## Shell completions

`ready-for-agent --completions` prints a standalone completion script
for Bash, Zsh, Fish, or `sh`. That path does not require Usage:

```bash
ready-for-agent --completions bash
ready-for-agent --completions zsh
ready-for-agent --completions fish
ready-for-agent --completions sh
```

Operators who install [Usage](https://usage.jdx.dev/) can generate
richer completions for Bash, Zsh, Fish, Nushell, and PowerShell from
`ready-for-agent --usage`. **Usage v5.1.0 is a runtime dependency** of
those generated scripts — they call `usage complete-word` when you
press Tab. The scripts are generated on demand and are not shipped in
the npm packages.

```bash
# Bash (requires bash-completion)
usage generate completion bash ready-for-agent \
  --usage-cmd "ready-for-agent --usage" \
  > ~/.local/share/bash-completion/completions/ready-for-agent

# Zsh
usage generate completion zsh ready-for-agent \
  --usage-cmd "ready-for-agent --usage" \
  > ~/.zsh/completions/_ready-for-agent

# Fish
usage generate completion fish ready-for-agent \
  --usage-cmd "ready-for-agent --usage" \
  > ~/.config/fish/completions/ready-for-agent.fish

# Nushell
usage generate completion nu ready-for-agent \
  --usage-cmd "ready-for-agent --usage" \
  > ~/.config/nushell/autoload/ready-for-agent.nu

# PowerShell
usage generate completion powershell ready-for-agent \
  --usage-cmd "ready-for-agent --usage" \
  > ready-for-agent.ps1
```

## Troubleshooting

### Startup fails with "Required host tools are missing from PATH"

Install the listed tools. Only `git` and the Forge requirement for
your repositories (`gh` for GitHub, `glab` for GitLab,
`AZURE_DEVOPS_EXT_PAT` for Azure DevOps) block startup. A missing
coding agent never does — it shows as Unavailable instead (see
below).

### Startup fails with SIGILL / "Illegal instruction"

The published Linux x64 binary is compiled with Bun's
`bun-linux-x64-baseline` target so CPUs with SSE4.2 but without
AVX2/BMI2 (for example Ivy Bridge) can run it. Older x64 CPUs without
SSE4.2 remain unsupported. If an older install still dies with `SIGILL`
or `Illegal instruction`, reinstall:

```bash
npx ready-for-agent@latest
```

`npx` can swallow the crash and print nothing. Run the platform
binary directly, or look for a launcher message that names
`bun-linux-x64-baseline`. Source checkouts on the same machine are
unaffected (`bun run ready-for-agent`).

### A labelled issue does not show up

- GitHub and GitLab: the issue must carry the `ready-for-agent` label.
  Azure DevOps: the Boards work item must carry the `ready-for-agent`
  tag — not a GitHub-style label. The harness only shows those.
- By default only issues **you** authored are listed. If someone else's
  `ready-for-agent` issue is missing, enable **Include all Issue Authors**
  in the repo settings to include issues created by any author.

### The coding agent shows as Unavailable

Its executable is missing from PATH, or it is not authenticated. Fix
that and use Recheck in Settings, or pick another backend there.

### Startup fails with "Cannot establish a trusted TLS connection"

Corporate TLS-inspection proxies (Netskope, Zscaler, Palo Alto,
mitmproxy, and similar) present a private root CA. `git`, `gh`, and
`curl` usually trust it via the OS keychain, but Ready for Agent runs
on Bun, which does **not** read that store — every GitHub/GitLab API
call then fails with a certificate error such as
`SELF_SIGNED_CERT_IN_CHAIN`.

On startup the harness probes each configured forge API host. When
TLS trust fails it stops immediately and prints the remedy. Export
your corporate root CA and point Bun at it with
`NODE_EXTRA_CA_CERTS` (honoured by the compiled binary as well):

```bash
# macOS — Netskope example (adjust -c to your proxy CA common name):
security find-certificate -a -c certadmin -p \
  /Library/Keychains/System.keychain > ~/.config/corp-ca.pem
export NODE_EXTRA_CA_CERTS=~/.config/corp-ca.pem

# Linux — use the PEM your IT provides:
export NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem
```

Set the variable in your shell profile (or the service unit that
starts the harness) so it applies on every launch, then restart
`ready-for-agent`.

### Merge PR fails on Azure DevOps with 401/403

Git fetch/push and Create PR can succeed with a narrower PAT than
complete. See [Forge token scopes](docs/forge-token-scopes.md) for
the extra scopes Merge PR needs.

### What if an item fails with an error message?

Agents have strict budgets, so the most common one is that it run out
of tries. Simply click retry.

You can always inspect the session locally if the error message is unclear, for example:

```
opencode -s ses_015198f50ffe6aMS7EDvD1U6ob
```

## Frequently Asked Questions

1. What coding CLI agents are supported?

[OpenCode](https://opencode.ai/),
[Codex](https://github.com/openai/codex), [Grok
Build](https://docs.x.ai/), and [Claude
Code](https://docs.anthropic.com/en/docs/claude-code). Settings
selects the instance-wide Agent Backend; the change hot-activates on
Save when no Work Items are unfinished. Model catalogs and effort
(thinking) options are backend-local, and build/review preferences
are remembered per backend. Models are always picked from the
backend's current catalog, never typed in.

2. Does the harness support a Forge other than GitHub?

Yes. GitLab and Azure DevOps are first-class Forges. Azure Boards
Ready discovery is a Boards tag `ready-for-agent` (not a label), auth
is `AZURE_DEVOPS_EXT_PAT`, and Merge Policy Always is the unattended
setting when the Azure repo has no CI. See
[Azure DevOps](#azure-devops).

3. Can I use my Claude subscription?

Yes, since we use Claude Code directly instead of the API, this is
permissible usage.

4. Can I run Claude Code through Amazon Bedrock?

Yes. See
[docs/claude-code-amazon-bedrock.md](docs/claude-code-amazon-bedrock.md).

5. Can I implement something locally, and then verify the work myself?

Yes — pick "Implement locally" from the kebab menu; see [Working on
issues](#working-on-issues).

6. Can I use a different model or coding agent per repo?

Yes — see [Per-repo settings](#per-repo-settings).

7. Does ready-for-agent help me to create GitHub issues?

No, this tool deliberately starts with existing issues. Creating these
issues is a very different scope. It falls into the category of a
software factory. [Victor Savkin](https://x.com/victorsavkin) has done
a very nice [write-up of what these tools
do](https://x.com/victorsavkin/status/2085381771516846093): they start
with finding work, they are not explorer work or creating work.

## Glossary

- **Clanker** — affectionate slang for a robot; here, the coding
  agent doing the work.
- **Harness** — this tool: the deterministic loop that steers
  clankers from issue to merged PR.
- **Forge** — the code-hosting platform for a repository: GitHub,
  GitLab, or Azure DevOps.
- **Agent Backend** — the coding-agent CLI the harness drives:
  OpenCode, Codex, Grok Build, or Claude Code.
- **Work Item** — one attempt to complete an issue through the work
  lifecycle, from implementation to merged PR.
- **Agent Turn** — one unattended invocation of the coding agent
  within a Work Item.
- **Needs Human** — a Work Item state where the harness cannot
  continue autonomously and hands back to you, recording why.
- **Recheck** — a Settings action that revalidates a coding agent and
  refreshes its model catalog.
- **Metaharness** — a harness that steers agent harnesses; see
  [metaharness.tools](https://metaharness.tools/).

The full domain language lives in [CONTEXT.md](CONTEXT.md), derived
from a versioned ontology under [`ontology/`](ontology/README.md).

## Architecture

Issues on the Forge remain the source of truth; the local SQLite
database is book-keeping. The backend serves a GraphQL API at
`http://127.0.0.1:6056/graphql`, and the Work Item lifecycle is
driven by a machine-readable ontology rather than ad-hoc enums.
Details in [ARCHITECTURE.md](ARCHITECTURE.md),
[CONTEXT.md](CONTEXT.md), [ontology/README.md](ontology/README.md),
and
[docs/why-agentic-systems-need-ontologies.md](docs/why-agentic-systems-need-ontologies.md).

## Contributing

Contributions welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

## Related work

- Inspired by [this blog
  post](https://lovable.dev/blog/85000-in-tokens-later-scaling-agentic-coding-at-lovable)
  from Alexander at Lovable
- ready-for-agent is an example of a
  [metaharness](https://metaharness.tools/).
- Victor Savkin describes [the workflow very
  well](https://x.com/victorsavkin/status/2085381771516846093),
  although we disagree on whether the tooling is always personal, or
  can be generalised a bit. Obviously my take is that with regards to
  GitHub/GitLab/Azure DevOps systems, and a single programmer a tool
  like ready-for-agent can give a significant productivity boost.
