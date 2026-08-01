import { type Page, expect } from "@playwright/test"
import {
  completeAndSaveFirstRunSettings,
  dismissFirstRunSettingsIfPresent,
  settingsDialog,
} from "../support/first-run-settings.ts"
import { Then, When } from "./fixtures.ts"

const PIPELINE_LANE_HEADERS = [
  "Queue",
  "Build",
  "Review",
  "PR",
  "Attention",
  "Merged",
] as const

const COMMITTED_PULL_REQUEST_PERIODS = [
  "Today",
  "Yesterday",
  "This week",
  "Last week",
  "Two weeks ago",
] as const

const primaryNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" })

When("I navigate to the Kanban board", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/$/)
  await dismissFirstRunSettingsIfPresent(page)
})

When("I open the home page", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/$/)
})

When("I complete and save Harness settings", async ({ page }) => {
  await completeAndSaveFirstRunSettings(page)
})

When("I cancel the Harness settings dialog if present", async ({ page }) => {
  await dismissFirstRunSettingsIfPresent(page)
})

When("I navigate to the legacy Kanban path", async ({ page }) => {
  await page.goto("/kanban")
  await expect(page).toHaveURL(/\/$/)
  await dismissFirstRunSettingsIfPresent(page)
})

When("I open the Repos page", async ({ page }) => {
  await page.goto("/repos")
  await expect(page).toHaveURL(/\/repos$/)
  await dismissFirstRunSettingsIfPresent(page)
})

When("I click the Home top nav control", async ({ page }) => {
  await primaryNav(page)
    .getByRole("link", { name: "Home", exact: true })
    .click()
})

When("I click the Repos top nav control", async ({ page }) => {
  await primaryNav(page)
    .getByRole("link", { name: "Repos", exact: true })
    .click()
})

Then("all six pipeline lane headers are visible", async ({ page }) => {
  const pipeline = page.getByRole("region", { name: "Lifecycle pipeline" })
  await expect(pipeline).toBeVisible()

  for (const lane of PIPELINE_LANE_HEADERS) {
    await expect(
      pipeline.getByRole("heading", { name: lane, exact: true }),
    ).toBeVisible()
  }
})

Then("the Pipeline jobs tab is active", async ({ page }) => {
  // Jobs destinations are a navigation list (not ARIA tabs).
  await expect(
    page.getByRole("navigation", { name: "Jobs" }).getByRole("link", {
      name: "Pipeline",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page")
})

Then("repository management is not rendered", async ({ page }) => {
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Add a repository" }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "No repositories configured" }),
  ).toHaveCount(0)
})

Then(
  "the committed pull request totals are visible above the board",
  async ({ page }) => {
    const dashboard = page.getByRole("region", {
      name: "Committed pull requests",
    })
    const pipeline = page.getByRole("region", { name: "Lifecycle pipeline" })
    await expect(dashboard).toBeVisible()

    for (const period of COMMITTED_PULL_REQUEST_PERIODS) {
      const periodLabel = dashboard.getByText(period, { exact: true })
      await expect(periodLabel).toBeVisible()
      await expect(periodLabel.locator("..").getByText(/^\d+$/)).toBeVisible()
    }

    const dashboardBox = await dashboard.boundingBox()
    const pipelineBox = await pipeline.boundingBox()
    if (dashboardBox === null || pipelineBox === null) {
      throw new Error(
        "Expected the dashboard and pipeline to have layout boxes",
      )
    }
    expect(dashboardBox.y + dashboardBox.height).toBeLessThanOrEqual(
      pipelineBox.y,
    )
  },
)

Then("the Repos top nav control is active", async ({ page }) => {
  const repos = primaryNav(page).getByRole("link", {
    name: "Repos",
    exact: true,
  })
  await expect(repos).toBeVisible()
  await expect(repos).toHaveAttribute("aria-current", "page")
})

Then("the Home top nav control is active", async ({ page }) => {
  const home = primaryNav(page).getByRole("link", {
    name: "Home",
    exact: true,
  })
  await expect(home).toBeVisible()
  await expect(home).toHaveAttribute("aria-current", "page")
})

Then("the Repos top nav control is not active", async ({ page }) => {
  const repos = primaryNav(page).getByRole("link", {
    name: "Repos",
    exact: true,
  })
  await expect(repos).toBeVisible()
  await expect(repos).not.toHaveAttribute("aria-current", "page")
})

Then("the Home top nav control is not active", async ({ page }) => {
  const home = primaryNav(page).getByRole("link", {
    name: "Home",
    exact: true,
  })
  await expect(home).toBeVisible()
  await expect(home).not.toHaveAttribute("aria-current", "page")
})

Then("I am on the Kanban board", async ({ page }) => {
  await expect(page).toHaveURL(/\/$/)
  await expect(
    page.getByRole("region", { name: "Lifecycle pipeline" }),
  ).toBeVisible()
})

Then("I am on the Repos page", async ({ page }) => {
  await expect(page).toHaveURL(/\/repos$/)
  // With repos, the configured list is the landmark (not the pipeline board).
  await expect(
    page.getByRole("region", { name: "Lifecycle pipeline" }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toBeVisible()
})

Then("the add-repository blank slate is visible", async ({ page }) => {
  // Pure visibility assert — do not Cancel here (would mask post-Save re-open).
  // Callers that open under unconfigured first-run should cancel explicitly.
  await expect(settingsDialog(page)).toBeHidden()
  await expect(
    page.getByRole("heading", { name: "No repositories configured" }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Add a repository" }),
  ).toBeVisible()
})

Then("the Harness settings dialog is visible", async ({ page }) => {
  await expect(settingsDialog(page)).toBeVisible({ timeout: 30_000 })
})

Then("the Harness settings dialog is hidden", async ({ page }) => {
  await expect(settingsDialog(page)).toBeHidden()
})

Then(
  "the blank slate instructs me to add a repository first",
  async ({ page }) => {
    const guidance = page.getByRole("region", { name: "Add a repository" })
    await expect(guidance).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "No repositories configured" }),
    ).toBeVisible()

    const pathField = page.locator("#add-repository-path")
    await expect(pathField).toBeVisible()
    await expect(pathField).toHaveAttribute(
      "placeholder",
      "/path/to/local/repo",
    )

    await expect(
      guidance.getByText(
        "Add a local Git repository with the operator binary:",
        { exact: true },
      ),
    ).toBeVisible()

    // Dynamic CLI string from GraphQL — assert the visible command (do not
    // hard-code npx vs binary).
    const commandCode = guidance.locator("code")
    await expect(commandCode).toBeVisible()
    const commandText = (await commandCode.innerText()).trim()
    expect(commandText).toMatch(/ready-for-agent add \/path\/to\/local\/repo$/)
  },
)

Then("the kanban board is not rendered", async ({ page }) => {
  await expect(
    page.getByRole("region", { name: "Lifecycle pipeline" }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Committed pull requests" }),
  ).toHaveCount(0)
})
