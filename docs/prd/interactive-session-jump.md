# Interactive Session Jump

> Draft product design from an operator grilling session.
> Domain: `CONTEXT.md`.

## Problem Statement

An operator who wants to continue a Work Item's canonical Session must currently identify its Agent Backend, reconstruct that backend's interactive resume command, and change to the correct worktree manually. This is error-prone across OpenCode, Grok Build, Codex Build, and Claude Code.

## Solution

Add an interactive command to the published `ready-for-agent` CLI:

```text
ready-for-agent jump <session-id>
```

For example:

```text
npx ready-for-agent@latest jump 85312e9f-9c57-42ef-9757-b2512cee57cd
```

The command resolves the opaque backend Session ID through the running Harness and continues the canonical Session with its captured Agent Backend. Inside tmux it creates a new window split evenly between the agent and a shell. Outside tmux it runs the agent directly as the foreground process in the invoking terminal; when the agent exits, control returns to the caller's shell without changing that shell's working directory. The agent uses the Work Item's persisted worktree as its working directory when it exists; otherwise it uses the CLI process's current directory.

This is an Interactive Session Continuation, not an Agent Turn or Lifecycle Step. Interactive messages become part of the Session seen by later Agent Turns.

## Session Resolution

- The argument is only an opaque backend Session ID. V1 does not accept a Work Item ID.
- The CLI is a thin GraphQL client. A simple query resolves the Session ID to exactly one Work Item and returns the captured Agent Backend, canonical Session ID, and worktree path.
- No match and multiple matches both fail. The current database does not enforce Session ID uniqueness, so ambiguity must not select an arbitrary Work Item.
- The Work Item's captured Agent Backend and exact Session identity are sufficient provenance. V1 does not add persisted executable version, Agent Model, Thinking Level, provider/auth mode, or backend persona.
- Jump does not inspect running Step Runs, backend Session files, Active Agent Backend readiness, or any other preflight beyond what is listed below. The operator decides when it is safe to jump.

## Interactive Backend Commands

The agent process uses the exact, non-forking interactive continuation supported by the captured Agent Backend, anchored to the working directory:

```text
opencode <dir> --session <session-id>
grok --cwd <dir> --resume <session-id>
codex resume -C <dir> <session-id>
claude --resume <session-id>            # child cwd is <dir>
```

Where `<dir>` is the persisted worktree when it exists, otherwise the CLI process's current directory.

These are interactive commands. Existing headless Agent Turn argument builders are not the contract for Jump.

Jump continues the canonical Session; it does not fork a human-only copy. It never uses backend shortcuts such as latest/continue/last or an interactive picker.

## Terminal Behavior

- When `TMUX` is absent, Jump runs the resolved interactive continuation command directly as the foreground process in the invoking terminal. It does not create a shell wrapper, terminal emulator, tmux server, window, or pane.
- A non-empty `TMUX` selects tmux mode; an absent or empty value selects direct mode. A stale `TMUX` value or later tmux failure is reported as a tmux failure and never triggers direct fallback.
- The direct child process starts in the resolved working directory, while the caller's shell remains in its original working directory after the agent exits. This child cwd anchors Claude Code; the other backend commands also receive their documented explicit directory argument.
- Direct continuation supports every Agent Backend for which Jump has an interactive continuation command: OpenCode, Grok Build, Codex Build, and Claude Code.
- Direct continuation requires both stdin and stdout to be attached to a TTY; stderr may be redirected. This local prerequisite is checked before contacting the Harness or resolving an executable.
- Direct continuation inherits the invoking process's complete environment and its stdin, stdout, and stderr. Jump prints no launch or exit banner; the Agent Backend owns the terminal presentation and diagnostics.
- A successfully started Agent Backend's exit becomes Jump's exit status, including nonzero and conventional signal-derived statuses, without an additional Jump error message, retry, or agent-specific cleanup.
- When `TMUX` is present, Jump retains the tmux behavior below.
- Jump creates a new window in the current tmux session rather than splitting the caller's current window.
- The new window contains an even left/right split. The left pane runs the Agent Backend and receives focus; the right pane is a shell.
- Both panes start in the persisted Work Item worktree when it exists; otherwise both panes use the CLI process's current directory.
- When the agent exits, its pane closes normally. The shell pane remains and expands; no wrapper shell replaces the agent.
- Tmux chooses the next available window index. The display name is `rfa:<first-8-session-id>`; the full Session ID is stored independently in a tmux user option, so a display-name collision is only cosmetic.
- Duplicate detection covers every tmux session on the current tmux server. A repeated Jump in the current tmux session selects the tagged window rather than creating a second interactive writer.
- If the tagged window remains but its agent pane has exited, Jump recreates the left agent pane in that window, restores the even split, and focuses the agent.
- If a tagged window belongs to another tmux session, Jump fails and reports that session/window location. It neither moves the caller nor starts a second interactive writer.
- Tmux starts the right pane without an explicit command, using its configured `default-command` and `default-shell` rather than interpreting `$SHELL` in the CLI.
- The agent pane inherits the operator CLI's environment via repeated `tmux -e KEY=VALUE` flags on `new-window` (create) and `split-window` (recreate). This is the same source the non-interactive Agent Turn path uses (`process.env` after `sanitizeInheritedEnvironment`), so mise `[env]`, direnv, and Bedrock/AWS variables such as `CLAUDE_CODE_USE_BEDROCK` reach the pane. Jump does **not** wrap the agent in a login shell.
- `TMUX`, `TMUX_PANE`, and `TERM` are omitted: tmux sets those on the pane, and a forwarded `TMUX_PANE` would break the agent's own tmux detection. `PWD`, `OLDPWD`, `SHLVL`, and `_` are omitted so `-c <workingDirectory>` remains authoritative.
- Undefined values are dropped. Jump keeps ambient Forge tokens (`stripForgeTokens: false`) because this is an Interactive Session Continuation in the operator's shell, not an Agent Turn. Per-backend Agent Turn env builders are not reused: they would add four workspace deps, and OpenCode's builder is Effect/Keymaxxer-scoped. Claude panes also set `DISABLE_AUTOUPDATER=1`, matching `packages/claude` Agent Turns.
- `tmux -e` requires tmux ≥ 3.0 on `new-window` and ≥ 3.2 on `split-window`. Jump documents this floor and does not version-gate: 3.2 shipped in 2021, and Jump already requires a working tmux client.

## Safety And Failures

Jump is lifecycle-neutral: it does not Pause, Start, Retry, Reset, or otherwise transition the Work Item. It does not check for running Step Runs or attempt to exclude concurrent Harness Agent Turns. The operator is responsible for deciding when it is safe to jump.

All prerequisites are checked before a tmux window is created or a direct agent process is started. The command fails when:

- direct continuation is selected but no interactive terminal is available;
- the Harness is unreachable;
- no Work Item owns the supplied Session ID;
- more than one Work Item owns the supplied Session ID;
- the captured Agent Backend is unsupported or its executable is unavailable on the CLI process's `PATH`;
- the direct Agent Backend process cannot be started; or
- tmux cannot create and arrange the window.

When the persisted worktree does not exist as a directory, Jump does not fail. The direct child or both tmux panes use the CLI process's current directory instead. This applies to terminal Work Items whose worktree has been cleaned up.

Tmux setup is transactional for ordinary failures: Jump creates the window detached, tags it immediately, completes the split and focus selection, and only then switches the invoking client. If setup fails, it kills only the window created by that invocation and reports the tmux failure; it never deletes a pre-existing tagged window.

Jump deliberately does not serialize simultaneous invocations. Tmux duplicate detection prevents normal sequential reuse, but two commands started at effectively the same time may race and create duplicate interactive writers. Direct invocations from separate terminals also have no cross-process duplicate detection. Jump is an operator-typed command, and avoiding those invocation patterns is preferred over adding a lock subsystem.

Jump is outside the finite JSON command protocol. In tmux, success is silent because switching to the focused agent pane is the confirmation. In direct mode, Jump itself remains silent while the Agent Backend owns terminal output. Jump-owned failures write concise, actionable text to stderr and exit `1`; after a successful direct launch, Jump instead returns the Agent Backend's exit status. Argument parsing retains the CLI framework's normal usage behavior.

## Implementation Seams

1. **GraphQL query**: a simple lookup that matches `work_item.session_id` and returns the captured backend, session ID, and worktree path. No jump tracking, no elaborate error codes, no lifecycle state inspection.
2. **CLI command**: `jumpCommand` in `cli.ts`, registered alongside existing subcommands. Selects tmux or direct mode, checks local prerequisites, resolves the session through GraphQL, and launches the continuation.
3. **Backend executable resolution**: resolve the captured backend's CLI binary to an absolute path on the CLI process's `PATH` before creating a tmux window or starting a direct process, so either mode launches the exact executable.
4. **tmux service**: a new thin service under `apps/ready-for-agent/src/services/` that owns tmux window creation, tagging, duplicate detection, split layout, and client switching.
5. **direct process service**: a thin process boundary that starts the resolved executable in the resolved working directory with inherited environment and terminal streams, then exposes its exit status without interpreting backend output.

## Out Of Scope

- Creating or attaching a tmux server from a normal terminal
- Forking Sessions
- Choosing another Agent Backend, worktree, Agent Model, Thinking Level, provider, or persona
- Restoring missing worktrees or backend-owned remote code
- Looking up by Work Item ID
- Direct Harness database access
- Session transcript or telemetry rendering
- Serialization of simultaneous Jump invocations
- Running Step Run or active Agent Turn detection
- Backend Session file existence or readiness preflight
- Active Agent Backend readiness checks
- Session lease, automatic Pause, or any durable exclusion mechanism
