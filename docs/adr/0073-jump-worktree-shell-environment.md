---
status: proposed
---

# Jump activates the target worktree through the user's interactive shell

Tmux-mode Interactive Session Continuation (`ready-for-agent jump`) used to
copy the invoking CLI's environment into the agent pane with one `tmux -e`
argument per variable. That command line grows with the operator's
environment until tmux rejects it (`command too long`), and it applies the
wrong project's variables to the worktree being continued. Changing
directory does not run shell startup. A shell started with `-c` or `-ic`
does not run the same first-prompt hooks an interactive terminal runs.

Jump no longer forwards that environment, and it has no knowledge of any
environment manager: it does not detect, invoke, parse, filter, or hook
them. In tmux mode the agent pane is the user's tmux `default-shell`,
started as an interactive shell that reads terminal input. Bash, zsh, ksh,
and fish are started with login `-l`. sh, dash, ash, and busybox are not,
because `-l` is not a portable flag for those binaries. The shell is passed
as direct argv, so a custom `default-command` is not used for the agent pane
and cannot receive the agent command, including when that program is not a
shell. The right-hand shell pane is unchanged: no explicit command, so
`default-command` or `default-shell` still applies there.

As soon as the pane exists, Jump types a short `exec` of a launcher and
Enter, using literal tmux input. It does not sleep or poll for a prompt.
Ordinary synchronous startup and the first prompt hook run before the shell
reads queued input. That is what applies worktree configuration the user
enabled in their normal shell startup. The launcher looks the Agent Backend
executable up on that shell's PATH and execs it, so the pane closes when
the agent exits. Jump does not pin an absolute path chosen from the
operator's PATH before that shell exists. A failed lookup or exec prints an
error in the pane and leaves the pane dead (`remain-on-exit`) instead of an
idle shell that a later Jump would treat as a running agent. Typing the
line only means tmux accepted the input. The tmux binary that reports the
failure is the one Jump already invoked, so the report does not depend on
the activated PATH.

Direct mode is unchanged. It still resolves the executable on the invoking
PATH and inherits the invoking environment. It does not start a worktree
shell.

The pane inherits the tmux session's existing environment, and the shell
applies the worktree on top of that baseline. The baseline can include
variables, including PATH, from the tmux server and from the client that
created the session. Jump does not promise a sterile environment and does
not strip those variables. Doing so would require knowing which variables
an environment manager owns.

Startup that reads or discards terminal input, replaces the shell, or
activates the environment asynchronously is outside this ordering. Jump
does not wait for those cases. Login bash reads `.bash_profile`, not
`.bashrc`, unless the user's profile sources it.

## Considered Options

Forwarding a sanitized copy of the CLI environment was rejected: it is the
failure being fixed, and an allowlist of manager variables would teach Jump
about those tools. Pasting the same environment into the typed command was
rejected for the same two reasons. Resolving the agent on the operator's
PATH before creating the pane was rejected because that path belongs to the
invoking project, not the worktree. `shell -ic` was rejected because it
does not run every synchronous prompt hook an interactive shell runs.
Waiting, polling the prompt, or detecting specific tools was rejected:
synchronous hooks already finish before queued input is read, and
asynchronous hooks are an explicit non-goal. Scrubbing the tmux baseline
into a sterile environment was deferred. It is separate work, not a reason
to integrate an environment manager here.

## Consequences

- Tmux Jump, both the first window and a recreated agent pane, runs the
  worktree's interactive shell before the agent. Direct Jump does not.
- Agent Turn environment policy, including Claude's `DISABLE_AUTOUPDATER`,
  is not applied to Jump panes. ADR 0056 is unchanged: interactive Grok
  continuation stays the Grok TUI.
- Supported shells for the typed exec are bash, zsh, ksh, fish, and POSIX
  sh (sh, dash, ash, busybox). zsh and ksh use POSIX quoting. The live
  fixture covers bash and, when installed, fish. Any other `default-shell`
  fails before a window is created.
- The tmux 3.0 / 3.2 floor existed only to support `tmux -e` on
  `new-window` and `split-window`. That floor is withdrawn. Jump still
  requires a working tmux client.
