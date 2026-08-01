# Validate Harness end to end against controlled Forge Repositories

Harness end-to-end validation runs the production-built application, worker, Keymaxxer Sidecar, command-line client, and browser against controlled End-to-End Fixture Repositories, without GraphQL or Forge mocks. Executable Gherkin via `playwright-bdd` adds each Repository from a fresh local checkout through the real CLI and waits for credential activation's automatic first Refresh Job to make the permanent Ready-labeled sentinel Issue visible in the UI.

## GitHub fixture

Private Repository `berenddeboer/test-ready-for-agent`, sentinel Issue `#22`, title `E2E fixture: Ready-labeled Issue refresh`. Clone uses Keymaxxer secret `GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT` (`provider=github`, `account=berenddeboer/test-ready-for-agent`).

## GitLab fixture

Throwaway project on `git.drupalcode.org` under operator control (default Project Path `sandbox/berend-test-ready-for-agent`), permanent open Ready-labeled sentinel with the same title convention, no blockers, and no Issue-closing MR. Clone uses Keymaxxer secret `GITLAB_TOKEN_GIT_DRUPALCODE_ORG_SANDBOX_BEREND_TEST_READY_FOR_AGENT` (`provider=gitlab`, `account=git.drupalcode.org/<project-path>`). HTTPS clone authenticates as `oauth2:<token>`. Operator bootstrap and Drupal.org API limitations are documented in `docs/e2e-fixture.md` and `scripts/setup-gitlab-e2e-fixture.sh`. Until the dual-secret vault includes the GitLab credential, the GitLab scenario soft-skips; `E2E_REQUIRE_GITLAB=1` fails closed.

## Shared run model

Each run starts with an empty, isolated Harness database. CI copies a checked-in encrypted Keymaxxer vault into a temporary home and unlocks it with the GitHub Actions secret `E2E_KEYMAXXER_MASTER_KEY`; `KEYMAXXER_APPROVE=deny` prevents headless prompts and fails closed. Local runs instead leave `~/.keymaxxer` untouched and may prompt normally. Scenarios have no automatic retry. Trusted `push` to `main` fail-closes if the vault secret is missing; pull requests run live e2e when the secret is available (same-repo) and skip it when unavailable (fork PRs), while still running quality gates. Playwright diagnostics are retained on failure. Scenarios assert the sentinel's fixed identity and do not reject unrelated Issues on the fixture project.

Work Item creation, Agent Turns, pull request / merge request creation, status checks, review, merge, and cleanup remain out of scope for the automated live e2e (operator demos may exercise the full GitLab lifecycle separately with write credentials).
