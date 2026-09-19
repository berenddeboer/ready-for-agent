# Local process ownership

Every Agent Turn and native repository command gets a new Linux cgroup before
repository code executes. This includes resumed Sessions, OpenCode, Codex Build,
Claude Code, Grok CLI and ACP, installation scripts, Pre-commit, Commit hooks,
Git operations, and credential-sidecar Git pushes. Session IDs, worktree files,
the index, and Step Run history are independent of this boundary.

## Supported execution hosts

Execution requires Linux, a unified cgroup v2 hierarchy, `cgroup.kill` (Linux
5.14 or newer), and a systemd user manager with delegation and
`--expand-environment=no` support (systemd 254 or newer). Run the Harness inside
the user's delegated hierarchy, for example from a desktop terminal, a systemd
user service.
The launcher must have permission to migrate itself between its current cgroup
and the invocation's delegated cgroup. A system service or container outside
that delegation is not sufficient just because it can reach the user's bus.

macOS, Windows, cgroup v1, containers without delegation, and hosts without a
working user manager **refuse these executions**. There is no opt-in process-tree
fallback. Existing binaries on other platforms can still expose the application,
but local repository/agent execution is unsupported until a durable ownership
implementation is available. This deliberately replaces the former best-effort
PPID/process-group cleanup. A launch error identifies the missing requirement;
repository code is not started without containment.

Check `systemctl --user show --property=Version` and
`test -f /sys/fs/cgroup/cgroup.controllers`. On headless hosts, arrange a persistent
systemd user manager and run the Harness as a user service. No global execution
lock is introduced; independent Work Items can execute concurrently.

## Launch and release

The Harness creates a transient delegated `rfa-inv-*.service` with a small owner
watchdog. A shell launcher writes its own PID to that invocation's payload
`cgroup.procs` **before** `exec`. The shell uses positional arguments, preserving
arguments, environment, cwd, and stdio. It refuses to exec if admission fails.
The kernel inherits membership through fork/exec, double-fork, setsid and
reparenting; cleanup does not need the original agent or wrapper to remain alive.
The ownership mechanism is process lifecycle management, not a security sandbox
against code deliberately manipulating the user's cgroups or external daemons.

Timeout, Interrupt, scope release, normal process exit, and final agent output
all release the same boundary. systemd sends SIGTERM to the entire cgroup,
waits the configured grace period (two seconds by default), then sends SIGKILL.
The Harness checks recursive `cgroup.events` population and uses `cgroup.kill`
if necessary, with a further one-second drain bound. Empty cgroups are then
removed, revoking even previously opened admission descriptors; a late join
makes removal fail rather than allowing unverified reuse. Control commands themselves
have bounded timeouts. Descendants holding stdout/stderr open are killed on
main-process exit, so inherited pipes cannot prevent normal release.

Finalizers are awaited before returning to lifecycle scheduling. If emptiness
cannot be verified, structured error diagnostics include the worktree and exact
unit; the worktree is blocked from launching another invocation until that
boundary can be reaped. Timeout and Interrupt remain the initiating outcomes,
with cleanup errors logged separately. Cleanup failure on a successful attempt
fails the attempt. No new Step Run reason vocabulary is introduced.

## Harness crash and restart

Unit names contain a hash of the canonical worktree path, the Harness PID and
Linux process start time, and a random invocation ID. Each watchdog checks that
exact owner identity every second. If the Harness dies, including SIGKILL,
the watchdog exits and systemd terminates the entire boundary. Graceful shutdown
uses the same awaited scope finalizers as Interrupt.

Before launching in a worktree, the Harness lists only its invocation units for
that canonical path, verifies owner identities, and reaps units whose owners
have died. Live owners and other worktrees are untouched. PID reuse cannot make
a dead owner appear live. A fresh boundary is allocated on every retry.

For a reported cleanup failure, inspect the **exact** unit from the diagnostic:

```sh
systemctl --user status rfa-inv-<reported-identity>.service
systemctl --user show rfa-inv-<reported-identity>.service -p ControlGroup
systemctl --user stop rfa-inv-<reported-identity>.service
```

Resolve the reported manager/delegation/permission failure, then Retry. Retry
verifies cleanup again before allowing repository execution. Do not kill by
process name or reap all units with a shared prefix while another Harness lives.

## Verification

The integration tests run real processes without model/API calls. They exercise
reparenting before timeout/Interrupt, TERM resistance, inherited pipes, normal
exit/final output, concurrent invocation isolation, revoked admission, abrupt
Harness death and restart recovery, real cleanup-observation failures, and a
Commit hook whose detached server retains a file lock. The hook tests verify
staged contents survive and an immediate retry acquires the lock and commits.
Grok ACP continuation has its own detached-wrapper regression tests.

GitHub Actions runs verification inside a systemd user service, with the job
environment supplied through a private temporary environment file. This avoids
requiring migration from the runner system service across a delegation boundary.

Run on a supported execution host:

```sh
bunx nx run agent-backend:test
bunx nx run grok:test
bunx nx run work-item-lifecycle:test
```

References: [kernel cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html),
[systemd delegation](https://systemd.io/CGROUP_DELEGATION/),
[systemd termination](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
