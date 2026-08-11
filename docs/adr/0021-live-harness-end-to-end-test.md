# Validate Harness end to end against controlled Forge Repositories

Harness end-to-end validation runs the production-built application, worker, Keymaxxer Sidecar, command-line client, and browser against controlled End-to-End Fixture Repositories, without GraphQL or Forge mocks. Executable Gherkin via `playwright-bdd` adds each Repository from a fresh local checkout through the real CLI and waits for credential activation's automatic first Refresh Job to make the permanent Ready-labeled sentinel Issue visible in the UI.

## GitHub fixture

Private Repository `berenddeboer/test-ready-for-agent`, sentinel Issue `#22`, title `E2E fixture: Ready-labeled Issue refresh`. Clone uses Keymaxxer secret `GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT` (`provider=github`, `account=berenddeboer/test-ready-for-agent`).

## GitLab fixture

Throwaway project on `git.drupalcode.org` under operator control (default Project Path `sandbox/berend-test-ready-for-agent`), permanent open Ready-labeled sentinel with the same title convention, no blockers, and no Issue-closing MR. Clone uses Keymaxxer secret `GITLAB_TOKEN_GIT_DRUPALCODE_ORG_SANDBOX_BEREND_TEST_READY_FOR_AGENT` (`provider=gitlab`, `account=git.drupalcode.org/<project-path>`). HTTPS clone authenticates as `oauth2:<token>`. Operator bootstrap and Drupal.org API limitations are documented in `docs/e2e-fixture.md` and `scripts/setup-gitlab-e2e-fixture.sh`. Until the dual-secret vault includes the GitLab credential, the GitLab scenario soft-skips; `E2E_REQUIRE_GITLAB=1` fails closed.

## Shared run model

Each run starts with an empty, isolated Harness database. Live e2e is split into **two** Nx targets / Playwright invocations (separate `webServer` boots) so product PATH and Keymaxxer policy can differ without installing OpenCode mid-suite (issue #958):

| Target | Tag filter | Env | Coverage |
| --- | --- | --- | --- |
| `harness:e2e-no-backend` | `@no-backend` only | `E2E_AGENT_BACKEND_MODE=no-opencode`, `KEYMAXXER_ENABLED=false` | Default Agent Backend Unavailable + first-run UI when OpenCode is absent (pure-absence and mixed-Ready via fake Claude). Vault-free so fork PRs still run it. |
| `harness:e2e` | everything except `@no-backend` | Fixture vault (below); ambient OpenCode allowed / expected in CI | Fixture Repository add/refresh, Kanban, Settings history, catalog-only Agent Models, etc. |

The live-Harness supervisor (`apps/harness/e2e/support/start-live-harness.ts`) always prepends a deterministic fake `claude` binary. In `no-opencode` mode it strips PATH directories that provide ambient `opencode`, `grok`, `codex`, and `claude`, then fails closed if those binaries still resolve (except the fake `claude`). Claude readiness is scenario-controlled (`firstParty` / `unauthenticated`) via the file protocol in `live-harness-control.ts`.

### Vault-backed suite

A shared e2e policy (`apps/harness/e2e/support/keymaxxer-e2e-policy.ts`) gates both the live-Harness supervisor and the fixture-clone helper before either touches Keymaxxer: given `E2E_KEYMAXXER_MASTER_KEY` (or the legacy `KEYMAXXER_MASTER_KEY`), it copies the checked-in encrypted Keymaxxer vault into a temporary home and unlocks it, with `KEYMAXXER_APPROVE=deny` preventing headless prompts. CI always resolves this fixture-vault mode for `harness:e2e` and fails closed if the secret is missing on trusted `main`. Without a master key, local runs must opt in explicitly with `E2E_ALLOW_KEYMAXXER_PROMPTS=1` to use the operator's own `~/.keymaxxer` vault and prompt normally; without that opt-in, vault-backed live e2e fails fast with a diagnostic before starting the Harness, Sidecar, or CLI rather than prompting silently. Scenarios have no automatic retry. Pull requests run vault-backed live e2e when the secret is available (same-repo) and skip it when unavailable (fork PRs), while still running quality gates and the vault-free `@no-backend` suite. Playwright diagnostics are retained on failure. Scenarios assert the sentinel's fixed identity and do not reject unrelated Issues on the fixture project.

### Vault-free suite

`KEYMAXXER_ENABLED=false` soft-disables Keymaxxer (same product switch as overnight / packed smoke): the supervisor skips vault seeding and Sidecar coordination. No fixture clone or Forge secrets are required. Overnight published-install smoke remains the packaging multi-arch gate and is not replaced by this suite.

Ordinary Harness test targets (`test`, `slow-test`, `smoke`) are a separate, credential-free concern: their Nx target environments force `KEYMAXXER_ENABLED=false`, and the unit-test runner (`scripts/run-unit-tests.sh`) exports the same override for direct invocation, so neither can inherit an ambient `KEYMAXXER_ENABLED=true` and start prompting.

Work Item creation, Agent Turns, pull request / merge request creation, status checks, review, merge, and cleanup remain out of scope for the automated live e2e (operator demos may exercise the full GitLab lifecycle separately with write credentials).
