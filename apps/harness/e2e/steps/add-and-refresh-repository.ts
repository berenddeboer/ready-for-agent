import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "@playwright/test"
import { cloneFixtureRepository } from "../support/clone-fixture-repo.ts"
import {
  E2E_GRAPHQL_URL,
  FIXTURE_REPOSITORY,
  SCENARIO_TIMEOUT_MS,
  SENTINEL_EXPECT_TIMEOUT_MS,
  SENTINEL_ISSUE_NUMBER,
  SENTINEL_ISSUE_TITLE,
} from "../support/constants.ts"
import { Given, Then, When, test } from "./fixtures.ts"

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
)

Given("the Harness has no configured Repositories", async ({ page }) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS)
  await page.goto("/")
  await expect(
    page.getByRole("heading", { name: "No repositories configured" }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toHaveCount(0)
})

Given("the End-to-End Fixture Repository is checked out", async ({ world }) => {
  const { checkoutPath, cleanup } = await cloneFixtureRepository()
  world.fixtureCheckoutPath = checkoutPath
  world.cleanupFixtureCheckout = cleanup
})

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

Then("the Repository appears in the Harness", async ({ page }) => {
  await page.goto("/")
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole("link", { name: FIXTURE_REPOSITORY }),
  ).toBeVisible()
})

Then(
  "the sentinel Issue appears after the automatic first Refresh Job",
  async ({ page }) => {
    // Tolerate unrelated Issues; only require the permanent sentinel identity.
    await expect(
      page.getByText(`#${SENTINEL_ISSUE_NUMBER}`, { exact: true }),
    ).toBeVisible({
      timeout: SENTINEL_EXPECT_TIMEOUT_MS,
    })
    await expect(
      page.getByRole("link", { name: SENTINEL_ISSUE_TITLE }),
    ).toBeVisible({ timeout: SENTINEL_EXPECT_TIMEOUT_MS })
  },
)
