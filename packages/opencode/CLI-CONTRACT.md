# OpenCode CLI contract

Real-CLI coverage for every production OpenCode subprocess the harness
launches. The suite is `bunx nx run opencode:cli-contract`. It runs the
installed OpenCode V2 binary through production launch paths. It does not
copy argv templates.

Argv unit tests in `test/build-args.spec.ts` stay useful. They are not
acceptance coverage: they missed the owned-server `--server` placement bug.

## Update rule

Any added or changed production OpenCode subprocess invocation must, in the
same change:

1. Update the inventory below, including each materially distinct
   argument or environment variant.
2. Add or adjust a case in `test/v2-cli-contract.spec.ts` that launches
   through the production entry point and the real binary.

A test that only compares argument arrays, or that rebuilds the command in
the test, does not satisfy this rule.

## What a passing case proves

Each case states its boundary in the spec. Operations that can finish
without inference assert exit status and JSON or server side effects.
Inference-triggering `run` and configured Agent Command turns stop at a
validation boundary (`Model unavailable` JSON, or command acceptance plus
the stored user message). They are not provider-semantic coverage and must
not call a cloud model.

`--help`, an unreachable server, a generic nonzero exit, or argv equality
alone is not a pass. Mutation cases require the exact diagnostic and fail
on any other error.

## How to run

```sh
bunx nx run opencode:cli-contract
```

Normal `nx test opencode` does not run this file, so unit tests stay fast.
The contract target is uncached: the external binary is not an Nx input.
Requires OpenCode 2 on `PATH`. No provider credentials.

The target prints the resolved binary and version, then each case's
redacted argv. Failures include exit status and truncated stdout/stderr.
Per-case timeout is 60 seconds. The spec also prints measured runtime.

CI required-check wiring is BER-36, which depends on this suite.

## Inventory

| Invocation | Production entry | Variants | Contract case | Boundary |
| --- | --- | --- | --- | --- |
| `opencode --version` | `Opencode.inspect` (`assertOpenCodeV2`) | isolated env | version discovery | V2 stdout from the production spawn; inspect continues |
| model catalog, Keymaxxer off | `Opencode.inspect` | `api --standalone get /api/model`, worktree cwd | default catalog | parsed models; CLI JSON `location.directory` is the cwd |
| model catalog, owned server | `Opencode.inspect` with `dedicatedServer` | `api --server` after `api`, directory header, quoting-sensitive path | explicit catalog | CLI JSON location equals the worktree; header is honored |
| `run` start | `AgentBackend.startTurn` | `--auto`, `--format json`, `model#thinking`, positional prompt tokens; default discovery and `--server` | start turn | exact `Model unavailable` JSON error; session stores the prompt once; no argument diagnostic. OpenCode 2.0.32 duplicates text after `--`, so production must not emit that separator. Exact prompt equality fails if it is reintroduced |
| `run` resume | `AgentBackend.continueTurn` | `--session`, null thinking omits `#variant`; both connection modes | resume turn | same session; variant absent; exact model diagnostic |
| prompt stdin | `AgentBackend.startTurn` when the prompt has a newline or exceeds the argv limit | stdin, not argv tokens | stdin prompt | stored message equals the prompt, including newlines |
| oversized Agent Command | `AgentBackend.startTurn` with `command` | refusal before spawn | command argv refusal | config error, OpenCode was not started |
| create session | `startTurn` command path, no session yet | `POST /api/session` JSON body, directory header, both modes | command turn | session location equals the worktree |
| switch model | `continueTurn` command path | `POST /api/session/{id}/model` JSON body, both modes | command continuation | session model id, provider, and variant match the pin |
| configured command | `startTurn` / `continueTurn` with `command` | `POST .../command` `--data`, quoting-sensitive text, both modes | command turn | stored user text is the template plus arguments |
| wait | command result collection | `POST /api/experimental/session/{id}/wait`, both modes | command turn | production wait spawn exits 0; unexpected argument errors fail the case |
| session export | command result collection | `session export --server` after `export`, both modes | command turn | export JSON contains the session id |
| interrupt | abort or timeout of a command turn | `POST /api/session/{id}/interrupt`, explicit server | interrupt | CLI JSON `interrupted` boolean; exact success, not a generic nonzero exit |
| `serve` | `startOwnedOpenCodeServer` | `--hostname 127.0.0.1`, ephemeral `--port`, `OPENCODE_SERVER_PASSWORD`, no `--service` | owned server | authenticated config contains the Keymaxxer URL; missing auth is 401; process cmdline matches; operator service URL unchanged |
| `service status` | `readOpenCodeServiceStatus` | isolated stopped service; isolated registration of the ephemeral server | service discovery | exact `stopped` text, then the ephemeral URL; does not print the operator URL |
| jump model pin | `interactiveResumeCommand` + `startInteractiveResume` | `POST .../model` `--data`, directory header, quoting-sensitive path | `apps/ready-for-agent/src/interactive-resume-v2-contract.test.ts` jump pin | pin exits 0; session model matches. Same Nx target as this package |
| jump TUI | same launcher, and `writeJumpLauncherScript` for the tmux script | `opencode <dir> --session <id> --auto`, quoting-sensitive path | same app contract file, jump TUI | both the direct launcher and the tmux script are still running after startup, with no launcher-failure text; a quick nonzero exit fails the case; pinned model remains after the script |
| BER-31 `--server` before `run` | production `startTurn`, spawner moves the flag | explicit server | BER-31 mutation | exact `Unrecognized flag: --server in command opencode run` |
| `--server` before `api` / before `export` | production command turn, spawner moves the flag | explicit server | placement mutations | exact unrecognized-flag diagnostic for that command |
| removed `--dir`, `--variant`, `--command` | production `startTurn`, spawner inserts the flag | explicit server | obsolete flag mutations | exact unrecognized-flag diagnostic |
| former `models --verbose` | production `inspect`, spawner replaces the catalog argv | explicit server | verbose mutation | exact `Unrecognized flag: --verbose in command opencode models` |

## Not a harness invocation

- `.agents/skills/audit-opencode-session-tokens` calls `opencode db path`.
  That skill is not a harness launch. `test/v2-api-contract.spec.ts` already
  asserts the command is rejected. Do not add a second copy here.
- `opencode service start`, `service stop`, and `serve --service` are not
  production. ADR 0078 forbids `--service` because it registers the
  operator's background service. The contract must not run them.

## Isolation

Cases set `HOME` and `XDG_*` to a temp directory and pass an allowlisted
environment. They do not inherit provider credentials. Default-mode clients
discover an isolated service registration that points at the ephemeral
`serve` process. Explicit-server cases omit that registration, so a missing
or misplaced `--server` cannot fall through to a service. The operator
service URL is read once before the suite and once after; it must be
unchanged. Servers and temp directories are removed on failure.
