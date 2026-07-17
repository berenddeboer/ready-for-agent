export const E2E_HARNESS_PORT = 4174
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_HARNESS_PORT}`
export const E2E_GRAPHQL_URL = `${E2E_BASE_URL}/graphql`

export const FIXTURE_GITHUB_OWNER = "berenddeboer"
export const FIXTURE_GITHUB_REPO = "test-ready-for-agent"
export const FIXTURE_REPOSITORY = `${FIXTURE_GITHUB_OWNER}/${FIXTURE_GITHUB_REPO}`
export const FIXTURE_SECRET_NAME =
  "GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT"

export const SENTINEL_ISSUE_NUMBER = 22
export const SENTINEL_ISSUE_TITLE = "E2E fixture: Ready-labeled Issue refresh"

/** Bounded wait for clone + CLI + one GitHub refresh + subscription. */
export const SCENARIO_TIMEOUT_MS = 180_000
/** Eventual UI assertions after the automatic first Refresh Job. */
export const SENTINEL_EXPECT_TIMEOUT_MS = 120_000
export const HARNESS_START_TIMEOUT_MS = 180_000
