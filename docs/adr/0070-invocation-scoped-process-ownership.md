# Invocation-scoped process ownership at launch

Status: accepted

Timeout and Interrupt of an Agent Turn or native repository command used a POSIX process group plus a PPID snapshot taken when cleanup started. A descendant that `setsid`/double-forked and whose intermediary exited before that snapshot was reparented to user systemd and survived, holding locks that blocked later attempts on the same Work Item.

Each Agent Turn and native repository command now establishes an Invocation Boundary before the spawned program can create children. On Linux that boundary is a dedicated cgroup v2 directory created as a sibling under a writable parent (typically the systemd user `app.slice`). A tiny `/bin/sh` wrapper writes its pid into `cgroup.procs` and `exec`s the real binary, so the agent or command starts already inside the cgroup. Descendants inherit it across new sessions and reparenting. Timeout and Interrupt SIGTERM owned pids/groups, then write `cgroup.kill`. Cleanup is awaited in the scope finalizer before a replacement attempt can run. Leftover pids after SIGKILL fail cleanup with diagnostics; timeout/interrupt remain the initiating Step Run reason.

A new turn on the same Session gets a new boundary. Independent Work Items are not serialized by a global execution lock. Harness startup reaps registry records whose creating process is dead. Linux fails closed if no writable cgroup parent exists. Darwin and Windows use documented best-effort process-group + PPID scanning and do not advertise complete containment.

Rejected alternatives: increasing Step Run timeouts, skipping hooks, killing by process name, another shutdown-only PPID walk, and treating an agent protocol cancel acknowledgement as OS cleanup.
