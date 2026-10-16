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
- The CLI is a thin GraphQL client. A simple query resolves the Session ID to exactly one Work Item and returns the captured Agent Backend, canonical Session ID, worktree path, and the Agent Model/Thinking Level Jump must pin.
- No match and multiple matches both fail. The current database does not enforce Session ID uniqueness, so ambiguity must not select an arbitrary Work Item.
- The Work Item's captured Agent Backend and exact Session identity are sufficient provenance. V1 does not add persisted executable version, provider/auth mode, or backend persona.
- Jump resolves the Agent Model and Thinking Level the next (or currently running) Agent Turn would use — Explicit Work Item Execution Profile when present, otherwise current settings — and pins them on the interactive resume command. This is a launch-scoped argv pin, not a new persisted Jump field. It prevents an OpenCode attach from writing the operator's ambient default into the shared Session model that an in-flight Step Run re-reads.
- Jump does not refuse a running Step Run, inspect backend Session files, or check Active Agent Backend readiness. The operator decides when it is safe to jump. A concurrent attach is still the operator's responsibility; pinning the Agent Model is what stops that attach from silently hijacking the in-flight turn's model. Model resolution may look at a running Step Run only to choose build vs review.

## Interactive Backend Commands

The agent process uses the exact, non-forking interactive continuation supported by the captured Agent Backend, anchored to the working directory, with that backend's native full permission-bypass mode so tool use does not wait for approval prompts:

```text
opencode <dir> --session <session-id> --auto -m <model>
grok --cwd <dir> --resume <session-id> --permission-mode bypassPermissions -m <model> [--reasoning-effort <level>]
codex resume --dangerously-bypass-approvals-and-sandbox -C <dir> -m <model> [-c model_reasoning_effort=<level>] <session-id>
claude --resume <session-id> --dangerously-skip-permissions --model <model> [--effort <level>]            # child cwd is <dir>
```

`<model>` and Thinking Level flags are omitted when the Harness cannot resolve a pin. OpenCode's interactive TUI has no `--variant` flag; Thinking Level for OpenCode is re-asserted on the Session record by the in-flight Agent Turn, not by Jump argv.

Where `<dir>` is the persisted worktree when it exists, otherwise the CLI process's current directory.

These flags apply only to the launched Interactive Session Continuation. Jump does not write user, Repository, Harness Config, or Agent Backend configuration. Codex uses `--dangerously-bypass-approvals-and-sandbox` (approvals and sandbox together), not a sandbox-only or approval-only override.

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
- Tmux starts the right-hand pane without an explicit command, so that pane uses tmux `default-command` when one is set, and otherwise `default-shell`. Jump does not read `$SHELL`.
- The agent pane does not use `default-command`. Jump reads the effective `default-shell` and starts that program as an interactive shell that reads terminal input, with no `-c` script: `shell -l` for bash, zsh, ksh, and fish, and the shell alone for sh, dash, ash, and busybox. The shell is passed as direct argv after `--`, so a custom `default-command` cannot receive the agent command, including when that program is not a shell. An empty `default-shell`, a shell Jump cannot quote, or a `default-shell` that is not executable fails before a window is created.
- Jump does not forward the invoking CLI environment and does not apply Agent Turn environment overrides. There is no repeated `tmux -e` list, and a Claude pane does not get `DISABLE_AUTOUPDATER`. The new shell inherits the tmux session environment. That baseline can include variables from the tmux server and from the client that created the session, including PATH. Jump does not promise a sterile environment and does not strip those variables. The worktree shell's startup still decides which Agent Backend executable runs. Strict removal of that baseline is separate work.
- After the agent pane exists, Jump arranges the split and focuses that pane, then types a short `exec` of a launcher into it with literal input (`send-keys -l`) and then Enter. It does not sleep or poll for a prompt, and it does not address that pane again after typing the exec: the pane closes as soon as the agent exits. Ordinary synchronous startup and the first prompt hook finish before the shell reads queued input, so worktree configuration the user enabled in their normal shell startup runs first. direnv and mise are examples of tools the user may have enabled; Jump does not detect, invoke, parse, or configure them.
- The launcher looks up the Agent Backend by executable name on that shell's PATH and execs it with the resume arguments. The pane therefore closes when the agent exits, and the shell pane remains. Jump does not resolve the agent to an absolute path on the operator's PATH before the shell starts. Spaces and quotes in paths and arguments keep their boundaries.
- Delivering the typed line only means tmux accepted the input. It does not mean the agent process has started. If the name cannot be found, or exec fails, the launcher prints an error in the pane, turns `remain-on-exit` on for that pane, and exits nonzero. A later Jump sees the dead tagged pane, creates a replacement, and closes the dead pane. An idle shell is not left tagged as a running agent.
- Startup that reads or discards terminal input, replaces the shell, or activates the environment asynchronously is outside ordinary prompt ordering. Jump does not add a delay for those cases. Login bash reads `.bash_profile`, not `.bashrc`, unless the user's profile sources it. zsh and ksh are quoted as POSIX shells; the live fixture covers bash and, when installed, fish.

## Safety And Failures

Jump is lifecycle-neutral: it does not Pause, Start, Retry, Reset, or otherwise transition the Work Item. It does not refuse a running Step Run or attempt to exclude concurrent Harness Agent Turns. The operator is responsible for deciding when it is safe to jump. An in-flight OpenCode Agent Turn re-asserts its configured Agent Model on the Session record so a concurrent attach cannot silently redirect that turn onto another model.

Prerequisites that can be known before a worktree shell exists are checked before a tmux window is created or a direct agent process is started. The command fails when:

- direct continuation is selected but no interactive terminal is available;
- the Harness is unreachable;
- no Work Item owns the supplied Session ID;
- more than one Work Item owns the supplied Session ID;
- the captured Agent Backend is unsupported;
- direct mode is selected and the Agent Backend executable is not on the CLI process's `PATH`;
- the direct Agent Backend process cannot be started;
- tmux mode is selected and `default-shell` is empty, unsupported, or not executable; or
- tmux cannot create and arrange the window.

In tmux mode the Agent Backend executable is resolved only after the worktree shell has started, because that shell's PATH is the one that must win. A missing executable is reported in the agent pane, which stays visible and dead, rather than as a refusal before the window exists. The next Jump can launch again once that shell can see the executable.

When the persisted worktree does not exist as a directory, Jump does not fail. The direct child or both tmux panes use the CLI process's current directory instead. This applies to terminal Work Items whose worktree has been cleaned up.

Tmux setup is transactional until the exec line is queued. Jump creates the window detached, tags it, arranges the split, and focuses the agent pane before typing the exec. It switches the invoking client after that line is queued. If setup fails before that line is queued, it kills only the window created by that invocation and reports the tmux failure; it never deletes a pre-existing tagged window. Once the line has been queued, Jump leaves the launcher in place so the shell can still run it. A failed `select-window` does not kill a window that was otherwise arranged. Queued input is not proof the agent is running; the launcher reports lookup and exec failures in the pane.

Jump deliberately does not serialize simultaneous invocations. Tmux duplicate detection prevents normal sequential reuse, but two commands started at effectively the same time may race and create duplicate interactive writers. Direct invocations from separate terminals also have no cross-process duplicate detection. Jump is an operator-typed command, and avoiding those invocation patterns is preferred over adding a lock subsystem.

Jump is outside the finite JSON command protocol. In tmux, success is silent because switching to the focused agent pane is the confirmation. In direct mode, Jump itself remains silent while the Agent Backend owns terminal output. Jump-owned failures write concise, actionable text to stderr and exit `1`; after a successful direct launch, Jump instead returns the Agent Backend's exit status. Argument parsing retains the CLI framework's normal usage behavior.

## Implementation Seams

1. **GraphQL query**: a simple lookup that matches `work_item.session_id` and returns the captured backend, session ID, worktree path, and the Agent Model/Thinking Level Jump must pin. No jump tracking, no elaborate error codes. Model resolution inspects a running Step Run only to choose build vs review; it does not refuse the Jump.
2. **CLI command**: `jumpCommand` in `cli.ts`, registered alongside existing subcommands. Selects tmux or direct mode, checks local prerequisites, resolves the session through GraphQL, and launches the continuation.
3. **Backend executable resolution**: direct mode resolves the captured backend's CLI binary to an absolute path on the CLI process's `PATH` before starting the process. Tmux mode passes the executable name through; the worktree shell's PATH selects the binary after its startup hooks.
4. **tmux service**: a thin service under `apps/ready-for-agent/src/services/` that owns tmux window creation, tagging, duplicate detection, split layout, client switching, and queueing the worktree-shell exec.
5. **direct process service**: a thin process boundary that starts the resolved executable in the resolved working directory with inherited environment and terminal streams, then exposes its exit status without interpreting backend output.

## Out Of Scope

- Creating or attaching a tmux server from a normal terminal
- Forking Sessions
- Choosing another Agent Backend, worktree, Agent Model, Thinking Level, provider, or persona (Jump pins the Work Item's configured selection; it does not offer a picker)
- Restoring missing worktrees or backend-owned remote code
- Looking up by Work Item ID
- Direct Harness database access
- Session transcript or telemetry rendering
- Serialization of simultaneous Jump invocations
- Running Step Run or active Agent Turn detection
- Backend Session file existence or readiness preflight
- Active Agent Backend readiness checks
- Session lease, automatic Pause, or any durable exclusion mechanism
- Detecting, configuring, or invoking direnv, mise, or any other environment manager
- Scrubbing the tmux server's inherited environment into a sterile baseline
