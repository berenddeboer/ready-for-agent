---
status: superseded by ADR-0031
---

# Opencode package wraps the CLI (Effect 4)

`@ready-for-agent/opencode` shells out to the opencode CLI (`run --auto --format json`) rather than using `@opencode-ai/sdk`. We need a fire-and-forget prompt runner with Session continue, not a long-lived server client; the CLI already owns session lifecycle, permissions (`--auto`), and event streaming. Process control uses Effect 4’s `ChildProcess` / `ChildProcessSpawner` (same stack as `apps/ready-for-agent`), so this package is on Effect 4 while most workspace packages remain on Effect 3 until they migrate.
