# Built-in headless Agent Backends

Ready for Agent supports coding agents through a built-in `@ready-for-agent/agent-backend` contract with separate OpenCode and Grok Build adapter packages. The shared package owns CLI process lifecycle, sanitized environment, timeout, process-tree cancellation, and normalized errors; adapters own binary arguments, environment additions, atomic readiness/model inspection, and structured-output decoding. This deliberately supports shipped headless CLI adapters rather than ACP, SDK, runtime plugin, or operator-defined command integrations.

A compatible Agent Backend must:

- run fully unattended in a supplied working directory with shell, git, and authenticated `gh` access;
- start a backend-owned durable Session and continue it by opaque ID across CLI and Harness restarts;
- expose the Session ID while the first Agent Turn is still running, either by accepting a preassigned ID or emitting it before completion;
- accept an explicit Agent Model and optional backend-defined Thinking Level on every turn, including switching them within one Session;
- expose an instance-wide Agent Model catalog through atomic readiness inspection;
- emit machine-readable output that the adapter can normalize to the Session ID and ordered final assistant text;
- provide the `/review` Agent Command at runtime; and
- tolerate bounded termination of the whole Agent Turn process tree on timeout, Reset, or Harness shutdown.

Project-instruction file conventions are backend-native rather than part of this contract. Runtime Agent Turn failures fail only the current Step Run; Agent Backend Unavailable is established only by startup inspection or an explicit recheck.

The shared `maxConcurrentAgentTurns` limit defaults to two and bounds in-flight CLI turns rather than durable Sessions. CI uses fake-CLI conformance suites and generic lifecycle tests; authenticated live adapter tests remain opt-in.

## Consequences

Grok Build is the first additional adapter, with stable ID `grok`. It runs with auto-update disabled so Harness operation cannot replace the CLI underneath active work. The adapter initially uses ambient `gh` authentication and does not integrate Keymaxxer.
