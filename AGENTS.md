## Agent skills

### Issue tracker

Issues live in GitHub Issues for berenddeboer/ready-for-agent (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (root CONTEXT.md + docs/adr/). See `docs/agents/domain.md`.

### Compatibility

Do not add support for legacy behavior, deprecations, or migration paths without
explicit user confirmation.

<!-- effect-solutions:start -->

## Effect

- Before writing Effect code, run `bunx effect-solutions list` and then
  `bunx effect-solutions <topic>...` for the relevant pattern.
- Real Effect implementations are available under
  `~/.local/share/effect-solutions/effect`; use them instead of guessing APIs.
- Common topics: `services-and-layers`, `data-modeling`, `error-handling`,
  `config`, `testing`, `cli`.

<!-- effect-solutions:end -->

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->

## Nx project config

Put Nx-specific config (`name`, custom targets like `test`/`migrate`/`serve`) in
each package's `project.json`, not under an `"nx"` key in `package.json`.
