# About

Opinionated agentic software engineering harness to massively increase landed PRs.

## Assumes
1. You are using GitHub.
2. Ideally you have set up AI code reviews via GitHub Actions.

## Requirements
1. git
2. GitHub CLI tool [gh](https://cli.github.com/)
3. [keymaxxer](https://github.com/glommer/keymaxxer)

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

# Architecture

- Centred around GitHub issues.
- GitHub issues are source of truth, local db is just for book-keeping.
- Only works on issues with label `ready-for-agent`.
- Assume user uses something like the Matt Pocock grill me (with
  docs), create PRD and split PRD into issues skills to create the
  issues.
- Creates a draft PR, and watches for all checks to become green.
- Assumes target repo has an AI reviewer (different model ideally) commenting.
- Addresses the PR review comments until AI is satisfied there's no
  purpose addressing more reviewer comments.
- Then converts PR to "Ready for review" and makes a decision whether
  to auto-merge, or HITL.
- Target repo defines everything around style and guidelines.
- This is just a harness to employ an agent swam to work on issues for a given repo.
- Very much allows human in the loop.
