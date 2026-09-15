# Measurement scope

`config.json` in this directory defines which files count as **production source** when this
repository is measured for maintainability, and which are excluded. It is committed on purpose:
without it the analyser generates a default scope, and a generated default is nobody's decision.

Committing it also records *when* the scope was last confirmed — the analyser reads the file's git
commit date, so a scope agreed long before the current code is visible as possibly stale rather
than silently trusted.

## What is excluded, and why

| Excluded | Reason |
|---|---|
| `docs/**` | documentation, not code that is maintained for behaviour |
| `*.d.ts` | type declarations, generated or mechanical |
| `git-*.txt` | data exports the analyser itself writes into the tree |
| `**/generated/**` | generated code |
| `*.md`, `*.txt` and other prose | documentation |
| `*.json`, `*.yaml`, `*.toml`, `*.xml` and other configuration | configuration, not behaviour |
| `*.sh`, `package.json`, `.github/**`, editor and tool dotfiles | build and deployment |
| tests (`*.test.*`, `*.spec.ts`, `**/e2e/**`, `*.feature`) | measured separately, as test code |
| `.agents/**` and `.claude/**` | agent skill definitions and agent configuration, not production source |

## Why `.claude/**` has to be excluded as well as `.agents/**`

Skill content lives once, under `.agents/skills/`, and every directory under `.claude/skills/` is a
symlink back into it. The analyser walks directories with `File.listFiles()`, which follows
symlinks and cannot be told not to, so it saw each shared skill file twice under two different
paths. Both copies were measured, and the duplication report ranked the pair as the second largest
duplicated block in the repository — 709 lines of code that exist once on disk.

Excluding both paths is what removes the phantom. Excluding only `.claude/**` would fix the
duplication report but would still count skill definitions as production source, which they are
not.

## One deliberate departure from the analyser's defaults

The standard rule set excludes **everything under any `bin/` directory**, on the reasoning that
`bin/` holds compiled binaries for distribution. That is true of a Java or .NET `bin/`. It is not
true here: `packages/*/src/bin/*.ts` and `apps/ready-for-agent/bin/*.js` are hand-written CLI entry
points, which is the ordinary convention in a TypeScript monorepo and the documented one in Rust
(`src/bin/*.rs`).

Applying the default rule removed **64 files** from the measurement, and that single rule accounted
for almost the whole difference in the resulting score:

| scope | main files | main LOC | maintainability |
|---|---:|---:|---:|
| default rules, `bin/` excluded | 440 | 93,633 | 1.88 |
| this config, `bin/` kept in scope | 504 | 95,760 | 1.86 |

So the `bin/` rule is removed here. Those 64 files are maintained TypeScript and belong in the
measurement.

## Changing it

Edit `config.json` and commit. The next analysis uses it as it stands and re-stamps the
confirmation date; nothing regenerates over a committed file. Adding a rationale here when you
change something is what makes the next reader's question answerable.
