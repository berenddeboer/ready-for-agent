---
name: claroview
description: Review Claroview/Sokrates duplicate reports or change measurement exclusions in this repository. Use for duplicates.txt, generated-code false positives, and maintainability measurement scope.
---

# Claroview measurement scope

1. Read `_sokrates/README.md` for the scope policy and `_sokrates/config.json`
   for the committed rules. These are the repository's analysis settings;
   the README explains how the next analysis picks up committed changes.
2. For a duplicate report, inventory its unique file paths and inspect candidate
   exclusions. Verify generated files against their headers or generator. Keep
   maintained templates, production CLI entry points, and hand-written migration
   logic in scope. Repeated production logic is a refactoring candidate.
3. Put confirmed generated outputs in `generated.sourceFileFilters`; classify
   test-only code under `test.sourceFileFilters`. Patterns are regular expressions,
   not globs. Use narrow rules and record their rationale in the README.
4. Parse the edited JSON and check each new pattern against both its intended
   output and maintained-source counterexamples. Summarize which report entries
   are affected; distinguish that estimate from a fresh analyser result.

Downloaded reports are snapshots. Updating the config does not rewrite them;
rerun analysis to see the resulting measurements.
