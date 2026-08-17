# Grok Agent Turns speak ACP

Status: accepted (Grok-only exception to ADR 0031’s “not ACP” rule; OpenCode, Codex Build, and Claude Code stay on headless CLI)

Grok Build’s headless `--resume` + `-p` never emits stdout on a real Implement Session (futex after `session/load`). ACP `session/load` / `session/resume` + `session/prompt` on `grok agent stdio` continues that same Session. Grok Agent Turns therefore use Agent Client Protocol: a shared Effect ACP client wrapping `@agentclientprotocol/sdk`, Grok adapter as first consumer. Lifecycle still calls `startTurn` / `continueTurn`. One ACP stdio spawn per Agent Turn. Continue prefers `session/resume`, falls back to `session/load`. Interactive Session Continuation stays the Grok TUI. Catalog inspect stays `grok models`. Other backends are unchanged until they have a reason to move.
