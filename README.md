# About

Opinionated agentic software engineering harness to massively increase landed PRs.

## Assumes
1. You are using GitHub.
2. You have your local environment setup for development for all repos
   you want to use with this tool.
3. Ideally you have set up AI code reviews via GitHub Actions.

## Requirements
1. git
2. GitHub CLI tool [gh](https://cli.github.com/)
3. [OpenCode](https://opencode.ai) on `PATH`
4. [keymaxxer](https://github.com/glommer/keymaxxer) — optional; workspace pins
   exact `keymaxxer@0.2.1` in the root lockfile for live e2e vault tooling

The operator binary fails fast at start if `git`, `gh`, or OpenCode is missing.

The backend starts Keymaxxer through its MCP server when available. It uses
`KEYMAXXER_ENTRYPOINT` when set to an existing path (run with `bun`), otherwise
the installed `keymaxxer` command on PATH (including the workspace pin).

When no Keymaxxer entrypoint or executable is available, the harness starts
without Keymaxxer and uses the user's ambient GitHub authentication. Set
`KEYMAXXER_ENABLED=false` to select this mode explicitly.

## Get started

1. Checkout a repo locally.
2. Add repo to harness.
3. If a repo has issues with label `ready-for-agent` they wil show up.
4. Start simple by implementing a single issue.

# How it works

The harness creates a new worktree for the issue, comes up with a
branch name, implements the issue, runs a local review, and then
creates a PR. The harness expects another agent to do a PR review, and
will respond to any PR review comments, until it is satisified the PR
review comments have been adequately addressed.

The PR review is merged if it seems low risk else a human is asked to
review it.

## Live end-to-end fixture

The private End-to-End Fixture Repository `berenddeboer/test-ready-for-agent`
and the checked-in encrypted Keymaxxer vault under `e2e/fixtures/keymaxxer/`
are maintained for live Harness e2e runs. See [docs/e2e-fixture.md](docs/e2e-fixture.md)
for the sentinel Issue contract, 90-day token rotation, and vault regeneration
(`scripts/regenerate-e2e-keymaxxer-vault.sh`). The master key is never committed;
CI uses the Actions secret `E2E_KEYMAXXER_MASTER_KEY`.

# Architecture

- Centred around GitHub issues.
- GitHub issues are source of truth, local db is just for book-keeping.
- Only works on issues with label `ready-for-agent`.
- Assume user uses something like the Matt Pocock grill me (with
  docs), create PRD and split PRD into issues skills to create the
  issues.
- Creates a draft PR, watches for all checks to become green, then marks the PR ready for review.
- Assumes target repo has an AI reviewer (different model ideally) commenting.
- Addresses the PR review comments until AI is satisfied there's no
  purpose addressing more reviewer comments.
- Then converts PR to "Ready for review" and makes a decision whether
  to auto-merge, or HITL.
- Target repo defines everything around style and guidelines.
- This is just a harness to employ an agent swam to work on issues for a given repo.
- Very much allows human in the loop.
