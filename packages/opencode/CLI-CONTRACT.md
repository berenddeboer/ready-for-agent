# OpenCode CLI contract

Real-CLI coverage for every production OpenCode subprocess the harness
launches. The suite is `bunx nx run opencode:cli-contract`. It runs the
installed OpenCode V2 binary through production launch paths. It also checks
owned-server identity and command submission over HTTP against that server.
It does not copy argv templates.

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
Ordinary inference-triggering cases stop at a validation boundary (`Model
unavailable` JSON, or command acceptance plus the stored user message).
The PR Status Check Handoff case completes a real turn with a scripted
loopback provider and a background shell job. The Implement interruption
case holds a real turn open with a streaming
loopback provider, checks that the server reports it active before interrupt,
then checks that only the target becomes inactive and its history remains.
No case calls a cloud model.

`--help`, an unreachable server, a generic nonzero exit, malformed
output, or argv equality alone is not a pass. Mutations that remain
invalid require the exact diagnostic and fail on any other error.

## How to run

```sh
bunx nx run opencode:cli-contract
```

That is the same target required CI runs. It needs the supported baseline
on `PATH` and no provider credentials. Normal `nx test opencode` does not
run this file, so unit tests stay fast.

The target prints the resolved binary, parsed version, and baseline pin
before any case. It then prints each case's redacted argv. Failures include
exit status and truncated stdout/stderr, and CI uploads that log. Per-case
timeout is 60 seconds. The spec also prints measured runtime. The run fails
if the passing case count is not the expected count, including an empty or
all-skipped suite.

Install the baseline the way CI does, then put it first on `PATH`:

```sh
bash scripts/install-opencode-v2.sh baseline
export PATH="$HOME/.opencode/bin:$PATH"
bunx nx run opencode:cli-contract
```

## Supported baseline and drift

The supported baseline is OpenCode **2.0.32**, recorded as
`OPENCODE_V2_BASELINE` in `mise.toml`. It is an env pin, not a mise tool
pin, so entering the repo does not switch the operator binary.

2.0.32 is the pin because that version reproduced the BER-31 `--server`
ordering incident, and it was the current `@opencode/cli` stable release
when the pin was set. Required PR and main jobs install that exact version
and fail if the resolved binary is missing, the probe fails, the major is
not 2, or the version is not the pin. The installed version and the tested
version are the same binary.

Scheduled workflow `OpenCode CLI contract drift` installs `@opencode/cli`
latest and runs this same target with `OPENCODE_CONTRACT_MODE=latest`. It
prints the baseline pin and the resolved latest version. A failure there
means upstream changed a command, flag, or contract. It is not a required
pull-request check, and it is not a license to point required jobs at
latest.

Drift coverage probes a version that is not yet in the `--server`
placement evidence table instead of refusing before it runs. The three
placement cases keep the same oracle; an unrecorded version that reaches
the no-inference boundary passes and logs `unprobed <version>`, and one
that rejects `--server` again fails as upstream drift. Required coverage
stays fail-closed: the pin must reject, and a non-pin version without an
evidence record throws `Refusing to guess a cutoff`. A drift pass is not
evidence. Record its resolved version in
`scripts/opencode-server-placement.ts` before it counts as an accepting
contract version.

The Nx target is uncached, and CI passes `--skip-nx-cache`. The external
binary version is not an Nx input, so a cached pass from another CLI must
not hide drift. The scheduled job executes the probes.

To move the pin, only after this suite passes on the candidate version:

1. Change `OPENCODE_V2_BASELINE` in `mise.toml`.
2. Run `bash scripts/install-opencode-v2.sh baseline` and the Nx target.
3. Confirm the log shows that version as both the pin and the resolved
   binary.

## Historical `--server` placement

Production still places `--server` where baseline **2.0.32** accepts it:
after `run`, after `api`, and after `session export`. That pin rejects the
flag before those commands (`Unrecognized flag: --server`). BER-31 is that
ordering bug. Required coverage keeps the exact rejection checks on the pin.

Drift run
[41303873900](https://github.com/berenddeboer/ready-for-agent/actions/runs/41303873900)
showed OpenCode **2.2.5** accepts those three placements and reaches the
no-inference boundary. A local real-binary probe on 2026-11-10 showed
OpenCode **2.2.6** does the same. That probe installed 2.2.6 the way CI
does: `bash scripts/install-opencode-v2.sh latest` resolved npm latest to
2.2.6 and ran the official installer with `--version 2.2.6
--no-modify-path`, into an isolated `HOME` so the operator binary and
service were not changed. The contract gate parsed that binary as `2.2.6`.
The three production placement cases in `test/v2-cli-contract.spec.ts` then
ran with `OPENCODE_CONTRACT_MODE=latest` and that binary first on `PATH`.
All three passed the existing oracles, not a new success condition:

- `--server` before `run` logged `server-before-run accepted` with argv
  `--server <isolated-url> run --auto --format json -m
  ready-for-agent-contract/no-such-model#high Contract probe`, exact
  `Model unavailable`, the session on that server, and the prompt stored
  once.
- `--server` before `api` logged `server-before-api accepted`. Every `api`
  call placed `--server` before `api`. Export stayed in production order
  (`session export --server <url>`). The case proved the isolated session,
  worktree, stored command, and a valid export with no command result.
- `--server` before `export` logged `server-before-export accepted`. `api`
  kept production order. Export used `session --server <url> export` and
  the same stored-command/export proof.

That same installed binary then passed `bunx nx run opencode:cli-contract`
with `OPENCODE_CONTRACT_MODE=latest`: 14 pass, 0 skip, 0 fail, including
interactive-resume.

Drift run
[42478079669](https://github.com/berenddeboer/ready-for-agent/actions/runs/42478079669)
installed 2.2.6 but threw before those cases probed the binary. It is not
this evidence. A direct 2.2.0 parser probe also got past flag rejection,
but it only reported an unreachable server. That is not proof of an
isolated server, worktree, or stored session, so 2.2.0 is not an accepting
contract version and not a cutoff. The suite does not use a semver
comparison. The pin must reject. 2.2.5, 2.2.6, and 2.2.7 must prove
acceptance.

A local real-binary probe on 2026-11-11 did the same for OpenCode
**2.2.7**, which was npm latest after the 2026-11-10 probe. The three
production placement cases again reached the no-inference boundary, and
the same binary passed `bunx nx run opencode:cli-contract` with
`OPENCODE_CONTRACT_MODE=latest`: 14 pass, 0 skip, 0 fail. Drift run
[42825652031](https://github.com/berenddeboer/ready-for-agent/actions/runs/42825652031)
installed 2.2.7 but threw before probing because that version was not yet
recorded. It is not this evidence.

Drift coverage no longer throws before probing an unrecorded version. It
runs the same placement cases and logs `unprobed <version>` on acceptance;
a rejection is reported as upstream drift. Required coverage still fails
closed for an unlisted version, so the table stays the record of proven
acceptance rather than a semver cutoff.

An accepted placement proves the explicit isolated server URL was used, the
session is on that server in the worktree, and the turn reached the same
boundary as the supported path: exact `Model unavailable` for `run`, or a
stored command plus a valid export for `api` and `export`. The command
export on that no-inference boundary has no assistant text, so the harness
returns `AgentBackendMalformedOutputError`. That error is the same oracle
as the supported command turn. It is not itself success, and it is not an
export-shape defect: the export JSON parses, contains the session id and
worktree, and `parseCommandTranscript` finds no command result. A result
the parser misses fails the case instead of being treated as compatibility.

## Inventory

| Invocation | Production entry | Variants | Contract case | Boundary |
| --- | --- | --- | --- | --- |
| `opencode --version` | `Opencode.inspect` (`assertOpenCodeV2`) | isolated env | version discovery | V2 stdout from the production spawn; inspect continues |
| model catalog, Keymaxxer off | `Opencode.inspect` | `api --standalone get /api/model`, worktree cwd; if empty before plugin settlement (2.4.x), starts a temporary private `serve` and polls `api --server <url> --header x-opencode-directory:<cwd> get /api/model` until settled | default catalog | parsed models; CLI JSON `location.directory` is the cwd |
| model catalog, owned server | `Opencode.inspect` with `dedicatedServer` | `api --server` after `api`, directory header, quoting-sensitive path; retries while empty until location settlement | explicit catalog | CLI JSON location equals the worktree; header is honored |
| `run` start | `AgentBackend.startTurn` | `--auto`, `--format json`, `model#thinking`, positional prompt tokens; default discovery and `--server` | start turn | exact `Model unavailable` JSON error; session stores the prompt once; no argument diagnostic. OpenCode 2.0.32 duplicates text after `--`, so production must not emit that separator. Exact prompt equality fails if it is reintroduced |
| `run` Implement start/resume | tracked `AgentBackend.startTurn` / `continueTurn` | `--session` with a fresh, invocation-owned ID or the existing ID; `--server` pins the configured or discovered server | plain prompt interrupt | the CLI creates and uses the fresh ID even before emitting a JSON session ID; resume reuses the same ID and history |
| `run` Implement with service disabled | tracked plain prompts without a shared service | `run --standalone` in the CLI invocation boundary | plain prompt interrupt | persist the exact boundary before inference; only confirm once cleanup is verified and the private provider request is cancelled; no shared service is contacted |
| `run` resume | `AgentBackend.continueTurn` | `--session`, null thinking omits `#variant`; both connection modes | resume turn | same session; variant absent; exact model diagnostic |
| prompt stdin | `AgentBackend.startTurn` when the prompt has a newline or exceeds the argv limit | stdin, not argv tokens | stdin prompt | stored message equals the prompt, including newlines |
| PR Status Check Handoff | `AgentBackend.continueTurn` with `replyToPromptOnly` | `run` on stdin with a unique prompt reference, then `session export` in the same connection mode (default discovery, explicit `--server` after `export`, or service disabled) | prompt-scoped continuation | the durably stored user prompt identifies the terminal answer and earlier assistant steps, including an output-limit continuation; earlier turns and subsequent background replies cannot supply the outcome |
| oversized non-owned Agent Command | `AgentBackend.startTurn` with `command` | refusal before spawn | command argv refusal | config error, OpenCode was not started |
| create session | `startTurn` command path, no session yet | `POST /api/session` JSON body, directory header, both modes | command turn | session location equals the worktree |
| switch model | `continueTurn` command path | `POST /api/session/{id}/model` JSON body, both modes | command continuation | session model id, provider, and variant match the pin |
| configured command, non-owned | `startTurn` / `continueTurn` with `command` | `POST .../command` `--data`, quoting-sensitive text, shared discovery or explicit non-owned server | command turn; api/export placement | stored user text is the template plus arguments |
| configured command, owned | `startTurn` / `continueTurn` with `command` | authenticated HTTP `POST /api/session/{id}/command`, encoded worktree header, JSON body, no command subprocess | command turn; oversized owned HTTP command; lost acknowledgement | ordinary and >128 KiB quote/newline-sensitive arguments expand in OpenCode and are stored once per turn in the intended session; a dropped acknowledgement after acceptance surfaces uncertainty, without replay |
| wait | command result collection and Implement stop confirmation | `POST /api/experimental/session/{id}/wait`, both modes | command turn; plain prompt interrupt | command wait exits 0; after an Implement interrupt, the target is no longer active |
| session export | command result collection | `session export --server` after `export`, both modes | command turn | export JSON contains the session id |
| interrupt | abort or timeout of a command turn | `POST /api/session/{id}/interrupt`, explicit server; same CLI path after the switch to HTTP submission on owned servers | owned HTTP command interrupt | CLI JSON `interrupted: true` after cancellation and timeout; only the intended session stops while another remains active |
| Implement prompt admission | `AgentBackend.startTurn` / `continueTurn` with stop confirmation | `GET /api/session/{id}/message?limit=20&order=desc&type=user`, both modes | plain prompt interrupt | filter to user messages before pagination so later assistant output cannot hide the submitted prompt; previous user messages do not count during resume |
| Implement prompt interrupt | abort or timeout of an admitted Implement plain prompt | `POST /api/session/{id}/interrupt`, both modes | plain prompt interrupt | `interrupted: true` for the active target, then idle on the server with its history intact. Another session in the same worktree stays active. An acknowledged `false` is the idle no-op, not a substitute for proving prompt admission |
| Implement server identity, non-owned | tracked Implement start/resume and `verifyImplementStopped` | `api get /api/info` for shared discovery/startup; `api get /api/info` with `--server` for shared or non-owned explicit identity | plain prompt interrupt | discovery still launches the CLI; persist the pinned target before running and verify the same process before accepting an idle read |
| Verify pending Implement stop | `AgentBackend.verifyImplementStopped` | `GET /api/session/active` pinned to the original server, both modes | plain prompt interrupt | refuses an active target; accepts an idle target; recovery does not send an interrupt |
| `serve` | `startOwnedOpenCodeServer` | `--hostname 127.0.0.1`, ephemeral `--port`, `OPENCODE_SERVER_PASSWORD`, no `--service` | owned server | authenticated config contains the Keymaxxer URL; missing auth is 401; process cmdline matches; operator service URL unchanged |
| `service status` | `readOpenCodeServiceStatus` | isolated stopped service; isolated registration of the ephemeral server | service discovery | exact `stopped` text, then the ephemeral URL; does not print the operator URL |
| jump model pin | `interactiveResumeCommand` + `startInteractiveResume` | `POST .../model` `--data`, directory header, quoting-sensitive path | `apps/ready-for-agent/src/interactive-resume-v2-contract.test.ts` jump pin | pin exits 0; session model matches. Same Nx target as this package |
| jump TUI | same launcher, and `writeJumpLauncherScript` for the tmux script | `opencode <dir> --session <id> --auto`, quoting-sensitive path | same app contract file, jump TUI | both the direct launcher and the tmux script are still running after startup, with no launcher-failure text; a quick nonzero exit fails the case; pinned model remains after the script |
| BER-31 `--server` before `run` | production `startTurn`, spawner moves the flag | explicit server | run placement | pin: exact `Unrecognized flag: --server in command opencode run`. 2.2.5, 2.2.6, and 2.2.7: exact `Model unavailable`, session on the isolated server, prompt stored once |
| `--server` before `api` | production command turn, spawner moves only `api` | explicit server | api placement | pin: exact unrecognized-flag diagnostic. 2.2.5, 2.2.6, and 2.2.7: isolated session, worktree, stored command, production export order, valid export with no command result |
| `--server` before `export` | production command turn, spawner moves only `export` | explicit server | export placement | pin: exact `Unrecognized flag: --server in command opencode session`. 2.2.5, 2.2.6, and 2.2.7: `api` keeps production order; export uses the moved flag and the same stored-command/export proof |
| removed `--dir`, `--variant`, `--command` | production `startTurn`, spawner inserts the flag | explicit server | obsolete flag mutations | exact unrecognized-flag diagnostic. Independent of placement, so one changed flag does not hide the others |
| former `models --verbose` | production `inspect`, spawner replaces the catalog argv | explicit server | verbose mutation | exact `Unrecognized flag: --verbose in command opencode models` |

Validate Spec uses the existing plain prompt stdin start contract in its own
checkout, and the prompt-scoped continuation contract on retry. It does not
change the CLI argv or reuse an implementation session.

The harness records the Implement session and server before the prompt is
submitted. If the first stop cannot be confirmed, the record survives a
harness restart and blocks another harness Implement turn for that Work Item.
For an owned server (BER-58), tracked start/resume and stop verification use
the official V2 client to send authenticated `GET /api/info` only to the
existing endpoint. The CLI is not launched for this read. The PID must match
the owned process, and the persisted URL/PID identity is unchanged. The same
required baseline and scheduled drift target checks the real endpoint,
including rejection of invalid auth, an unreachable endpoint, and a saved
identity for another process at the same address.

A later Reset checks the original attached server without sending another
interrupt. For a standalone turn, it stops and verifies only the recorded
process boundary before removing the worktree.
If the session is still active, the operator can stop it in OpenCode and retry
Reset. OpenCode v2 interrupts by session, so concurrent use of that same
session by another OpenCode client during Implement or Reset is not covered.

For BER-57, OpenCode 2.0.32, 2.2.7, and 2.3.2 preserve user, assistant, and
synthetic messages in projection order in `session export`. Assistant
messages carry a `finish` reason; tool steps precede the terminal answer.
A synthetic background notice can start another reply before an `idle`
message is recorded, so idle alone is not sufficient. CLI stdout exposes
assistant message IDs but not the submitting user message ID. The pin can
reconcile the terminal text without emitting its `step_finish`; newer
OpenCode can wait for a job and emit both the requested and background
replies. Read the first settled answer after the exact stored prompt, not
the latest reply or a timestamp window. Export is read-only; the harness
does not stop the CLI early or cancel jobs to collect an outcome.

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
