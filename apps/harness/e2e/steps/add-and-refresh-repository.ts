import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "@playwright/test"
import {
  ensureNoConfiguredRepositories,
  graphqlRequest,
} from "../support/clear-repositories.ts"
import {
  type FixtureForge,
  cloneFixtureRepository,
  gitlabFixtureSpec,
  hasFixtureCredential,
} from "../support/clone-fixture-repo.ts"
import {
  E2E_GRAPHQL_URL,
  FIXTURE_GITHUB_REPOSITORY,
  FIXTURE_GITLAB_PROJECT_PATH,
  GITHUB_SENTINEL_ISSUE_NUMBER,
  GITHUB_SENTINEL_ISSUE_TITLE,
  GITLAB_SENTINEL_ISSUE_TITLE,
  SCENARIO_TIMEOUT_MS,
  SENTINEL_EXPECT_TIMEOUT_MS,
  gitlabSentinelIssueNumber,
} from "../support/constants.ts"
import { dismissFirstRunSettingsIfPresent } from "../support/first-run-settings.ts"
import { Given, Then, When, test } from "./fixtures.ts"

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
)

const displayRepositoryFor = (forge: FixtureForge): string =>
  forge === "gitlab" ? FIXTURE_GITLAB_PROJECT_PATH : FIXTURE_GITHUB_REPOSITORY

const sentinelFor = (forge: FixtureForge) =>
  forge === "gitlab"
    ? {
        number: gitlabSentinelIssueNumber(),
        title: GITLAB_SENTINEL_ISSUE_TITLE,
      }
    : {
        number: GITHUB_SENTINEL_ISSUE_NUMBER,
        title: GITHUB_SENTINEL_ISSUE_TITLE,
      }

/**
 * Ensure no default build model so first-run Settings auto-opens on the next
 * load. Same-backend updateConfig rejects an empty model; clear by switching
 * Agent Backend with an empty model (first-run style), then switch back to the
 * original backend still with an empty model so the shared e2e process keeps
 * the prior default backend identity.
 */
const ensureFirstRunSettingsRequired = async () => {
  const data = await graphqlRequest<{
    config: {
      selectedAgentBackend: string
      defaultModel: string | null
      maxConcurrentAgentTurns: number
      maxConcurrentWorkItems: number
    }
    agentBackends: ReadonlyArray<{ id: string }>
  }>(
    `query {
      config {
        selectedAgentBackend
        defaultModel
        maxConcurrentAgentTurns
        maxConcurrentWorkItems
      }
      agentBackends { id }
    }`,
  )
  if (
    data.config.defaultModel === null ||
    data.config.defaultModel.length === 0
  ) {
    return
  }

  const originalBackend = data.config.selectedAgentBackend
  const alternate = data.agentBackends.find(
    (backend) => backend.id !== originalBackend,
  )
  if (alternate === undefined) {
    throw new Error(
      "Cannot restore first-run settings: default build model is set and no alternate Agent Backend is available to clear it",
    )
  }

  const clearModelInput = (selectedAgentBackend: string) => ({
    selectedAgentBackend,
    defaultModel: null,
    defaultThinkingLevel: null,
    reviewModel: null,
    reviewThinkingLevel: null,
    maxConcurrentAgentTurns: data.config.maxConcurrentAgentTurns,
    maxConcurrentWorkItems: data.config.maxConcurrentWorkItems,
  })

  // Backend change allows empty model; same-backend empty model is rejected.
  const clearedOnAlternate = await graphqlRequest<{
    updateConfig: {
      defaultModel: string | null
      selectedAgentBackend: string
    }
  }>(
    `mutation UpdateConfig($input: UpdateConfigInput!) {
      updateConfig(input: $input) {
        defaultModel
        selectedAgentBackend
      }
    }`,
    { input: clearModelInput(alternate.id) },
  )
  if (
    clearedOnAlternate.updateConfig.defaultModel !== null &&
    clearedOnAlternate.updateConfig.defaultModel.length > 0
  ) {
    throw new Error(
      `Expected empty defaultModel after switching to ${alternate.id}, got ${JSON.stringify(clearedOnAlternate.updateConfig.defaultModel)}`,
    )
  }
  if (clearedOnAlternate.updateConfig.selectedAgentBackend !== alternate.id) {
    throw new Error(
      `Expected selectedAgentBackend ${alternate.id} after clear, got ${clearedOnAlternate.updateConfig.selectedAgentBackend}`,
    )
  }

  // Return to the original backend while still unconfigured (first-run style).
  const restored = await graphqlRequest<{
    updateConfig: {
      defaultModel: string | null
      selectedAgentBackend: string
    }
  }>(
    `mutation UpdateConfig($input: UpdateConfigInput!) {
      updateConfig(input: $input) {
        defaultModel
        selectedAgentBackend
      }
    }`,
    { input: clearModelInput(originalBackend) },
  )
  if (
    restored.updateConfig.defaultModel !== null &&
    restored.updateConfig.defaultModel.length > 0
  ) {
    throw new Error(
      `Expected empty defaultModel after restoring ${originalBackend}, got ${JSON.stringify(restored.updateConfig.defaultModel)}`,
    )
  }
  if (restored.updateConfig.selectedAgentBackend !== originalBackend) {
    throw new Error(
      `Expected selectedAgentBackend ${originalBackend} after restore, got ${restored.updateConfig.selectedAgentBackend}`,
    )
  }
}

Given("the Harness is empty with first-run settings required", async () => {
  test.setTimeout(SCENARIO_TIMEOUT_MS)
  await ensureNoConfiguredRepositories()
  await ensureFirstRunSettingsRequired()
})

Given("the Harness has no configured Repositories", async () => {
  test.setTimeout(SCENARIO_TIMEOUT_MS)
  // GraphQL-only setup: do not tour home/Repos blank slates here. The Kanban
  // scenario whose assertion *is* that empty UI still checks it.
  await ensureNoConfiguredRepositories()
})

Given("the End-to-End Fixture Repository is checked out", async ({ world }) => {
  const { checkoutPath, cleanup, spec } = await cloneFixtureRepository("github")
  world.fixtureCheckoutPath = checkoutPath
  world.cleanupFixtureCheckout = cleanup
  world.fixtureForge = "github"
  world.fixtureDisplayRepository = spec.displayRepository
})

Given(
  "the GitLab End-to-End Fixture Repository is checked out",
  async ({ world }) => {
    const spec = gitlabFixtureSpec()
    // Soft-skip until the dual-secret fixture vault is regenerated (operator
    // step after the throwaway project and PAT exist). Hard-require with
    // E2E_REQUIRE_GITLAB=1 so CI can fail closed once the vault includes
    // the GitLab credential. Infrastructure errors (missing master key,
    // keymaxxer list failure) always throw rather than soft-skipping.
    let hasCredential: boolean
    try {
      hasCredential = hasFixtureCredential(spec)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        [
          "Could not inspect the Keymaxxer vault for the GitLab e2e credential.",
          detail,
        ].join(" "),
      )
    }
    if (!hasCredential) {
      const requireGitlab =
        process.env.E2E_REQUIRE_GITLAB === "1" ||
        process.env.E2E_REQUIRE_GITLAB === "true"
      const message = [
        "GitLab e2e credential is not present in the Keymaxxer vault.",
        `Expected secret ${spec.secretName} (provider=gitlab account=${spec.account}).`,
        "Create the throwaway fixture on git.drupalcode.org, mint a PAT, and run",
        "./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab",
        "(see docs/e2e-fixture.md).",
        "Set E2E_REQUIRE_GITLAB=1 to fail instead of skipping.",
      ].join(" ")
      if (requireGitlab) {
        throw new Error(message)
      }
      test.skip(true, message)
      return
    }

    const {
      checkoutPath,
      cleanup,
      spec: cloneSpec,
    } = await cloneFixtureRepository("gitlab")
    world.fixtureCheckoutPath = checkoutPath
    world.cleanupFixtureCheckout = cleanup
    world.fixtureForge = "gitlab"
    world.fixtureDisplayRepository = cloneSpec.displayRepository
  },
)

When("I add the Repository with the CLI", async ({ world }) => {
  const checkoutPath = world.fixtureCheckoutPath
  if (!checkoutPath) {
    throw new Error("Fixture checkout path is missing from the scenario world")
  }

  const result = spawnSync(
    "bun",
    ["run", "ready-for-agent", "add", checkoutPath],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        READY_FOR_AGENT_GRAPHQL_URL: E2E_GRAPHQL_URL,
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  )

  if (result.status !== 0) {
    throw new Error(
      [
        "CLI failed to add the End-to-End Fixture Repository.",
        result.stderr?.trim() ||
          result.stdout?.trim() ||
          `exit ${result.status}`,
      ].join("\n"),
    )
  }
})

Then("the Repository appears in the Harness", async ({ page, world }) => {
  const forge = world.fixtureForge ?? "github"
  const display = world.fixtureDisplayRepository ?? displayRepositoryFor(forge)

  await page.goto("/repos")
  await dismissFirstRunSettingsIfPresent(page)
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("link", { name: display })).toBeVisible()
})

Then(
  "the sentinel Issue appears after the automatic first Refresh Job",
  async ({ page, world }) => {
    const forge = world.fixtureForge ?? "github"
    const sentinel = sentinelFor(forge)
    // Tolerate unrelated Issues; only require the permanent sentinel identity.
    await expect(
      page.getByText(`#${sentinel.number}`, { exact: true }),
    ).toBeVisible({
      timeout: SENTINEL_EXPECT_TIMEOUT_MS,
    })
    await expect(page.getByRole("link", { name: sentinel.title })).toBeVisible({
      timeout: SENTINEL_EXPECT_TIMEOUT_MS,
    })
  },
)
