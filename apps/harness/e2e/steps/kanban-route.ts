import { type Page, expect } from "@playwright/test"
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

const dismissFirstRunSettings = async (page: Page) => {
  // The isolated E2E database has no default build model, so first-run
  // Settings opens automatically. Dismiss it to exercise the route beneath.
  const settingsDialog = page.getByRole("dialog", {
    name: "Harness settings",
  })
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole("button", { name: "Cancel" }).click()
  await expect(settingsDialog).toBeHidden()
}

When("I navigate to the Kanban board", async ({ page }) => {
  await page.goto("/kanban")
  await expect(page).toHaveURL(/\/kanban$/)
  await dismissFirstRunSettings(page)
})

When("I open the Home dashboard", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/$/)
  await dismissFirstRunSettings(page)
})

When("I click the Kanban top nav control", async ({ page }) => {
  await primaryNav(page)
    .getByRole("link", { name: "Kanban", exact: true })
    .click()
})

When("I click the Home top nav control", async ({ page }) => {
  await primaryNav(page)
    .getByRole("link", { name: "Home", exact: true })
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
  await expect(
    page.getByRole("tab", { name: "Pipeline", exact: true }),
  ).toHaveAttribute("aria-selected", "true")
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

Then("the Home top nav control is active", async ({ page }) => {
  const home = primaryNav(page).getByRole("link", { name: "Home", exact: true })
  await expect(home).toBeVisible()
  await expect(home).toHaveAttribute("aria-current", "page")
})

Then("the Kanban top nav control is active", async ({ page }) => {
  const kanban = primaryNav(page).getByRole("link", {
    name: "Kanban",
    exact: true,
  })
  await expect(kanban).toBeVisible()
  await expect(kanban).toHaveAttribute("aria-current", "page")
})

Then("the Home top nav control is not active", async ({ page }) => {
  const home = primaryNav(page).getByRole("link", { name: "Home", exact: true })
  await expect(home).toBeVisible()
  await expect(home).not.toHaveAttribute("aria-current", "page")
})

Then("the Kanban top nav control is not active", async ({ page }) => {
  const kanban = primaryNav(page).getByRole("link", {
    name: "Kanban",
    exact: true,
  })
  await expect(kanban).toBeVisible()
  await expect(kanban).not.toHaveAttribute("aria-current", "page")
})

Then("I am on the Kanban board", async ({ page }) => {
  await expect(page).toHaveURL(/\/kanban$/)
  await expect(
    page.getByRole("region", { name: "Lifecycle pipeline" }),
  ).toBeVisible()
})

Then("I am on the Home dashboard", async ({ page }) => {
  await expect(page).toHaveURL(/\/$/)
  // Home keeps the dashboard + Jobs; repository management lives on /repos.
  await expect(
    page.getByRole("region", { name: "Committed pull requests" }),
  ).toBeVisible()
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Lifecycle pipeline" }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toHaveCount(0)
})
