export const E2E_HARNESS_PORT = 4174
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_HARNESS_PORT}`
export const E2E_GRAPHQL_URL = `${E2E_BASE_URL}/graphql`

// --- GitHub End-to-End Fixture Repository ---
export const FIXTURE_GITHUB_OWNER = "berenddeboer"
export const FIXTURE_GITHUB_REPO = "test-ready-for-agent"
export const FIXTURE_GITHUB_REPOSITORY = `${FIXTURE_GITHUB_OWNER}/${FIXTURE_GITHUB_REPO}`
export const FIXTURE_GITHUB_SECRET_NAME =
  "GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT"

export const GITHUB_SENTINEL_ISSUE_NUMBER = 22
export const GITHUB_SENTINEL_ISSUE_TITLE =
  "E2E fixture: Ready-labeled Issue refresh"

// --- GitLab End-to-End Fixture Repository (git.drupalcode.org) ---
// Project path and sentinel iid are fixed identities once the operator
// provisions the throwaway sandbox (see docs/e2e-fixture.md). Env overrides
// support local bootstrap before constants are locked.
export const FIXTURE_GITLAB_FORGE_HOST =
  process.env.E2E_GITLAB_FORGE_HOST?.trim() || "git.drupalcode.org"
/** Project Path and UI display identity for the GitLab fixture Repository. */
export const FIXTURE_GITLAB_PROJECT_PATH =
  process.env.E2E_GITLAB_PROJECT_PATH?.trim() ||
  "sandbox/berend-test-ready-for-agent"
/**
 * Keymaxxer account is `<forge-host>/<project-path>` with provider=gitlab.
 * Canonical secret name follows the GitHub fixture naming convention.
 */
export const FIXTURE_GITLAB_VAULT_ACCOUNT = `${FIXTURE_GITLAB_FORGE_HOST}/${FIXTURE_GITLAB_PROJECT_PATH}`
export const FIXTURE_GITLAB_SECRET_NAME =
  "GITLAB_TOKEN_GIT_DRUPALCODE_ORG_SANDBOX_BEREND_TEST_READY_FOR_AGENT"

const parsePositiveIssueNumber = (
  raw: string | undefined,
  fallback: number,
): number => {
  const source = raw?.trim()
  if (source === undefined || source === "") {
    return fallback
  }
  const parsed = Number(source)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `E2E_GITLAB_SENTINEL_ISSUE_NUMBER must be a positive integer, got ${JSON.stringify(raw)}`,
    )
  }
  return parsed
}

/**
 * Sentinel iid for the GitLab fixture. Parsed lazily so a bad
 * `E2E_GITLAB_SENTINEL_ISSUE_NUMBER` only breaks the GitLab scenario, not the
 * whole Playwright suite at module import.
 * Bootstrap placeholder is `1` until setup-gitlab-e2e-fixture.sh locks the real iid.
 */
export const gitlabSentinelIssueNumber = (): number =>
  parsePositiveIssueNumber(process.env.E2E_GITLAB_SENTINEL_ISSUE_NUMBER, 1)

export const GITLAB_SENTINEL_ISSUE_TITLE =
  "E2E fixture: Ready-labeled Issue refresh"

/**
 * Bounded wait for clone + CLI + one Forge refresh + subscription.
 * Sized for dual-scenario runs that may spend up to ~30s clearing Repositories
 * before a 120s sentinel wait (GitHub then GitLab share one Harness process).
 */
export const SCENARIO_TIMEOUT_MS = 240_000
/** Eventual UI assertions after the automatic first Refresh Job. */
export const SENTINEL_EXPECT_TIMEOUT_MS = 120_000
export const HARNESS_START_TIMEOUT_MS = 180_000
