# End-to-End Fixture Repositories and Keymaxxer vault

Live Harness end-to-end validation uses controlled Fixture Repositories and a
checked-in encrypted Keymaxxer vault that never holds the master key. GitHub
and GitLab scenarios share the same vault, CI gate, and Gherkin wiring under
`apps/harness/e2e`.

## GitHub End-to-End Fixture Repository

- Repository: `berenddeboer/test-ready-for-agent` (private)
- Sentinel Issue: `#22`
- Exact title: `E2E fixture: Ready-labeled Issue refresh`
- Must stay open and labeled `ready-for-agent`
- No hierarchy, no blockers, no Issue-closing pull request
- Non-sentinel Issues such as `#11` and `#18` must not carry `ready-for-agent`
- Scenarios do not reject unrelated Issues

## GitLab End-to-End Fixture Repository

- Forge Host: `git.drupalcode.org`
- Project Path (default): `sandbox/berend-test-ready-for-agent`
  - Override with `E2E_GITLAB_PROJECT_PATH` during bootstrap
- Sentinel Issue: fixed title `E2E fixture: Ready-labeled Issue refresh`
  - Lock the iid via `E2E_GITLAB_SENTINEL_ISSUE_NUMBER` or the default in
    `gitlabSentinelIssueNumber()` after first creation
- Must stay open and labeled `ready-for-agent`
- No hierarchy, no blockers, no Issue-closing merge request
- Scenarios do not reject unrelated Issues (same convention as GitHub)

### Operator bootstrap (one-time)

Drupal.org blocks project creation and many project-setting mutations through
the GitLab REST API. Provision the throwaway project in the UI:

1. Create a sandbox (or other project you control) on Drupal.org so it appears
   under `git.drupalcode.org`.
2. In GitLab project settings, **enable Issues** (sandboxes and many
   `project/*` namespaces default Issues off). Enable CI/CD only if you will
   exercise pipeline watching manually.
3. **Push at least one commit** on the default branch (empty projects fail
   `git clone --depth 1` and vault regeneration `git ls-remote`).
4. Export the path if it differs from the default:

   ```bash
   export E2E_GITLAB_PROJECT_PATH='sandbox/<your-path>'
   ```

   The Keymaxxer **secret name** stays fixed
   (`GITLAB_TOKEN_GIT_DRUPALCODE_ORG_SANDBOX_BEREND_TEST_READY_FOR_AGENT`) even
   when the path override changes; only the vault `account` metadata and clone
   URL follow `E2E_GITLAB_PROJECT_PATH` / `E2E_GITLAB_FORGE_HOST`.

5. With a write-capable PAT or `glab` session, create the label and sentinel:

   ```bash
   ./scripts/setup-gitlab-e2e-fixture.sh
   ```

6. Lock the printed sentinel iid via `E2E_GITLAB_SENTINEL_ISSUE_NUMBER` or the
   default in `gitlabSentinelIssueNumber()`
   (`apps/harness/e2e/support/constants.ts`).
7. Mint a **read-only** personal access token at
   `https://git.drupalcode.org/-/user_settings/personal_access_tokens` with
   `read_api` and `read_repository` (no write scopes for CI).
8. Regenerate the dual-secret vault (below), run the isolated GitLab clone
   smoke test, then commit the encrypted vault files.

The automated Gherkin scenario mirrors GitHub: add the Repository through the
CLI and assert the sentinel appears after the automatic first Refresh Job. Full
lifecycle demos (Implement → draft MR → pipeline → merge → Issue close) remain
operator-driven with write credentials and Auto-merge, same out-of-scope
boundary as the original GitHub live e2e (ADR 0021).

Until the GitLab secret is present in the checked-in vault, the GitLab scenario
**soft-skips** so trusted `main` CI stays green. Set `E2E_REQUIRE_GITLAB=1` to
fail closed once the vault includes the GitLab credential.

## Checked-in vault

Path: `e2e/fixtures/keymaxxer/`

| File | Purpose |
| --- | --- |
| `vault.db` | Encrypted Keymaxxer database |
| `vault.meta.json` | Non-secret cipher metadata (`kdf: "none"` for external master key) |

The vault always contains the GitHub fixture credential. After GitLab bootstrap
it also contains the GitLab fixture credential:

| Secret name | provider | account | access |
| --- | --- | --- | --- |
| `GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT` | `github` | `berenddeboer/test-ready-for-agent` | read-only |
| `GITLAB_TOKEN_GIT_DRUPALCODE_ORG_SANDBOX_BEREND_TEST_READY_FOR_AGENT` | `gitlab` | `git.drupalcode.org/<project-path>` | read-only |

The master key is **not** committed. CI supplies it as the repository Actions
secret `E2E_KEYMAXXER_MASTER_KEY` (exposed to the e2e step as
`KEYMAXXER_MASTER_KEY`).

## Fine-grained GitHub token

Create a fine-grained personal access token in the GitHub UI (not via the API):

1. Resource owner: your user
2. Repository access: only `berenddeboer/test-ready-for-agent`
3. Permissions (read-only — nothing writeable):
   - Contents: **Read**
   - Metadata: **Read**
   - Issues: **Read**
   - Pull requests: **Read**
4. Expiration: **90 days** initially

`scripts/regenerate-e2e-keymaxxer-vault.sh` probes the token: repository /
Issues / pull-request reads must succeed, and Issue/Contents writes must fail.
Do not set `E2E_ALLOW_CONTENTS_WRITE_TOKEN=1` except for a temporary local
bootstrap; CI must use a Contents-read-only token.

When the token approaches expiry, create a replacement, regenerate the vault,
and commit the new encrypted files. Keep the same master key when possible so
`E2E_KEYMAXXER_MASTER_KEY` does not need to change.

## GitLab personal access token

Create a personal access token on the Forge Host:

1. Open `https://git.drupalcode.org/-/user_settings/personal_access_tokens`
2. Scopes for CI: `read_api`, `read_repository`
3. Restrict to the fixture project when the instance supports project-scoped
   tokens; otherwise rotate promptly
4. Expiration: match your org's policy (document the date next to the vault
   regeneration commit)

For local **setup** of the sentinel Issue only, a temporary write-capable token
is acceptable. Pass `E2E_ALLOW_GITLAB_WRITE_TOKEN=1` when regenerating so the
probe allows issue-create; regenerate again with a read-only token before
relying on CI.

Keymaxxer metadata (must match harness lookup):

- `provider=gitlab`
- `account=<forge-host>/<project-path>` (for example
  `git.drupalcode.org/sandbox/berend-test-ready-for-agent`)
- `environment=test`
- `access=read-only`

## Regenerate the vault

Requires workspace `keymaxxer@0.2.1` (`bun install` pins it in the lockfile).

```bash
# Prefer reusing the existing Actions master key (load from your secret store
# into the environment — never put the value on the shell command line):
export E2E_KEYMAXXER_MASTER_KEY
# paste/export the 64-hex value into the env only

# GitHub-only (bootstrap era, before dual-secret vault):
./scripts/regenerate-e2e-keymaxxer-vault.sh
# paste the fine-grained GitHub token at the hidden prompt (or pipe it on stdin)
# After the vault contains the GitLab secret, this form refuses to run unless
# you pass --github-only (explicitly drops GitLab) or --with-gitlab.

# GitHub + GitLab (required once the GitLab fixture project exists):
export E2E_GITLAB_PROJECT_PATH='sandbox/berend-test-ready-for-agent'  # if non-default
./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab
# paste GitHub token, then GitLab PAT (two prompts / two stdin lines)

# Or generate a new master key file (mode 0600), then set the Actions secret:
./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab \
  --write-master-key-to /tmp/e2e-keymaxxer-master.key
gh secret set E2E_KEYMAXXER_MASTER_KEY < /tmp/e2e-keymaxxer-master.key
shred -u /tmp/e2e-keymaxxer-master.key 2>/dev/null || rm -f /tmp/e2e-keymaxxer-master.key
```

Rules enforced by the script:

- Temporary `HOME` only — never copies over or reads `~/.keymaxxer`
- Token values enter through stdin (hidden on a TTY), never as CLI arguments
- Master key only via `E2E_KEYMAXXER_MASTER_KEY` or `--write-master-key-to`
- Probes that GitHub Issues/Contents writes are denied
- With `--with-gitlab`, probes project/issue/MR reads and prefers a read-only PAT
- Commits only the encrypted `vault.db` and `vault.meta.json`

## Isolated clone smoke test

### GitHub

```bash
TMP_HOME=$(mktemp -d)
mkdir -p "$TMP_HOME/.keymaxxer"
cp e2e/fixtures/keymaxxer/vault.db e2e/fixtures/keymaxxer/vault.meta.json "$TMP_HOME/.keymaxxer/"
export HOME="$TMP_HOME"
export KEYMAXXER_MASTER_KEY  # from E2E_KEYMAXXER_MASTER_KEY / secret store
export KEYMAXXER_APPROVE=deny
bunx keymaxxer@0.2.1 run --secrets GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT -- \
  bash -c 'git clone "https://x-access-token:${GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT}@github.com/berenddeboer/test-ready-for-agent.git" /tmp/test-ready-for-agent-e2e-clone'
```

### GitLab

```bash
TMP_HOME=$(mktemp -d)
mkdir -p "$TMP_HOME/.keymaxxer"
cp e2e/fixtures/keymaxxer/vault.db e2e/fixtures/keymaxxer/vault.meta.json "$TMP_HOME/.keymaxxer/"
export HOME="$TMP_HOME"
export KEYMAXXER_MASTER_KEY
export KEYMAXXER_APPROVE=deny
SECRET=GITLAB_TOKEN_GIT_DRUPALCODE_ORG_SANDBOX_BEREND_TEST_READY_FOR_AGENT
PROJECT_PATH="${E2E_GITLAB_PROJECT_PATH:-sandbox/berend-test-ready-for-agent}"
bunx keymaxxer@0.2.1 run --secrets "$SECRET" -- \
  bash -c "git clone \"https://oauth2:\${${SECRET}}@git.drupalcode.org/${PROJECT_PATH}.git\" /tmp/gitlab-e2e-clone"
```

These leave the developer's real Keymaxxer vault untouched.

## CI gating

Live Gherkin e2e runs in a dedicated **`harness`** job (dev smoke + live e2e)
in parallel with **`quality-gates`** (`lint` / `knip` / `test` / `typecheck`
plus harness slow-test) on trusted pushes to `main`
(`.github/workflows/ci-cd.yml`) and on pull requests
(`.github/workflows/pr.yml`). Playwright Chromium is installed only when the
vault secret is available (always on `main`; same-repo PRs only). Both
workflows unlock the fixture vault with repository secret
`E2E_KEYMAXXER_MASTER_KEY`.

| Event | Secret available | Policy |
| --- | --- | --- |
| `push` to `main` | required | Fail closed if missing |
| Same-repo PR | yes | Run live e2e |
| Fork PR | no (secrets not exposed) | Skip live e2e only (log + continue); `harness` still runs smoke; quality-gates and pinact still run |

Required status checks (after the former monolithic `main` job was split):

| Workflow | Require |
| --- | --- |
| **PR** | `quality-gates`, `harness`, `pinact` |
| **CI/CD** | `quality-gates`, `harness`, `packed-install`, `pinact` |

If branch protection or a ruleset still names `main`, update it when this lands
or merges can stall (stale check never completes) or under-gate e2e (if only
`quality-gates` is re-added).

See ADR 0021. GitHub and GitLab scenarios share that single
`bunx nx run harness:e2e` step.
