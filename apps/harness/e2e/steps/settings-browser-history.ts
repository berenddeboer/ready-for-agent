/**
 * Playwright-BDD steps for routed Harness Settings history (issue #840).
 */
import { type Page, expect } from "@playwright/test"
import {
  ensureConfiguredDefaultBuildModel,
  settingsDialog,
} from "../support/first-run-settings.ts"
import { Given, Then, When } from "./fixtures.ts"

const awaitCatalogSettled = async (
  dialog: ReturnType<typeof settingsDialog>,
) => {
  await expect(dialog.getByText("Loading settings...")).toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(dialog.getByText("Loading catalog…")).toHaveCount(0, {
    timeout: 30_000,
  })
}

const maxConcurrentTurnsInput = (page: Page) =>
  settingsDialog(page).locator('input[name="maxConcurrentAgentTurns"]')

/** Match `/settings` optionally with search params. */
const settingsPathPattern = /\/settings\/?(?:\?.*)?$/
const reposPathPattern = /\/repos\/?(?:\?.*)?$/

type UpdateConfigIntercept = {
  failNext: boolean
  delay: { resolve: () => void; promise: Promise<void> } | null
}

const interceptByPage = new WeakMap<Page, UpdateConfigIntercept>()

const interceptFor = (page: Page): UpdateConfigIntercept => {
  let state = interceptByPage.get(page)
  if (state === undefined) {
    state = { failNext: false, delay: null }
    interceptByPage.set(page, state)
  }
  return state
}

const installUpdateConfigRoute = async (page: Page) => {
  // Replace any prior handler for this page so scenario flags apply.
  await page.unroute("**/graphql").catch(() => {})
  await page.route("**/graphql", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") {
      await route.continue()
      return
    }
    let query = ""
    try {
      const body = request.postDataJSON() as { query?: string }
      query = body.query ?? ""
    } catch {
      await route.continue()
      return
    }
    if (!query.includes("updateConfig")) {
      await route.continue()
      return
    }

    const state = interceptFor(page)
    if (state.failNext) {
      state.failNext = false
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          errors: [{ message: "Simulated settings save failure" }],
        }),
      })
      return
    }

    if (state.delay !== null) {
      const gate = state.delay
      await gate.promise
      await route.continue()
      return
    }

    await route.continue()
  })
}

/**
 * Savable Harness Config for Save-history scenarios. Complements zero-repo
 * Givens that dismiss first-run without choosing a build model.
 */
Given("the Harness has a configured default build model", async () => {
  await ensureConfiguredDefaultBuildModel()
})

When("I open the home page with theme dark", async ({ page }) => {
  await page.goto("/?theme=dark")
  await expect(page).toHaveURL(/theme=dark/)
})

When("I open Harness settings from the masthead", async ({ page }) => {
  await installUpdateConfigRoute(page)
  await page.getByRole("button", { name: "Settings" }).first().click()
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  await awaitCatalogSettled(dialog)
})

When("I open the settings path directly", async ({ page }) => {
  await installUpdateConfigRoute(page)
  await page.goto("/settings")
  await expect(page).toHaveURL(settingsPathPattern)
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await awaitCatalogSettled(dialog)
})

When("I cancel the Harness settings dialog", async ({ page }) => {
  const dialog = settingsDialog(page)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
})

When("I press Escape in the Harness settings dialog", async ({ page }) => {
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

When(
  "I change the max concurrent Agent Turns draft to {string}",
  async ({ page }, value: string) => {
    const input = maxConcurrentTurnsInput(page)
    await expect(input).toBeVisible()
    await input.fill(value)
    await expect(input).toHaveValue(value)
  },
)

When("I go back in the browser", async ({ page }) => {
  await page.goBack()
})

When("I go forward in the browser", async ({ page }) => {
  await page.goForward()
})

When("I go back in the browser while Save is pending", async ({ page }) => {
  // useBlocker prevents the history transition; do not wait for a navigation.
  await page.evaluate(() => {
    window.history.back()
  })
  // Poll for stability instead of a fixed sleep (blocker must keep /settings).
  await expect(page).toHaveURL(settingsPathPattern)
  await expect
    .poll(
      async () => {
        const dialog = settingsDialog(page)
        const dialogOpen = await dialog.isVisible()
        const saving = await dialog
          .getByRole("button", { name: "Saving…" })
          .isVisible()
          .catch(() => false)
        const onSettings = settingsPathPattern.test(
          new URL(page.url()).pathname,
        )
        return dialogOpen && saving && onSettings
      },
      { timeout: 5_000 },
    )
    .toBe(true)
})

When("I refresh the page", async ({ page }) => {
  await page.reload()
})

When("I save Harness settings without changing values", async ({ page }) => {
  const dialog = settingsDialog(page)
  await awaitCatalogSettled(dialog)
  const save = dialog.getByRole("button", { name: "Save settings" })
  await expect(save).toBeEnabled({ timeout: 15_000 })
  await save.click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
})

When("Harness settings Save is forced to fail", async ({ page }) => {
  interceptFor(page).failNext = true
  await installUpdateConfigRoute(page)
})

When("I save Harness settings expecting failure", async ({ page }) => {
  const dialog = settingsDialog(page)
  await awaitCatalogSettled(dialog)
  const save = dialog.getByRole("button", { name: "Save settings" })
  await expect(save).toBeEnabled({ timeout: 15_000 })
  await save.click()
  // Failed Save must keep the dialog open.
  await expect(dialog).toBeVisible()
})

When("Harness settings Save is delayed", async ({ page }) => {
  let resolveGate = () => {}
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve
  })
  interceptFor(page).delay = { resolve: resolveGate, promise }
  await installUpdateConfigRoute(page)
})

When("I start saving Harness settings", async ({ page }) => {
  const dialog = settingsDialog(page)
  await awaitCatalogSettled(dialog)
  const save = dialog.getByRole("button", { name: "Save settings" })
  await expect(save).toBeEnabled({ timeout: 15_000 })
  await save.click()
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeVisible({
    timeout: 15_000,
  })
})

When("the delayed Harness settings Save completes", async ({ page }) => {
  const state = interceptFor(page)
  const gate = state.delay
  state.delay = null
  gate?.resolve()
  const dialog = settingsDialog(page)
  await expect(dialog).toBeHidden({ timeout: 60_000 })
})

Then("the browser location is the settings path", async ({ page }) => {
  await expect(page).toHaveURL(settingsPathPattern)
})

Then(
  "the browser location is the settings path with theme dark",
  async ({ page }) => {
    await expect(page).toHaveURL(/\/settings\/?\?theme=dark$/)
  },
)

Then("the browser location is the home path", async ({ page }) => {
  await expect(page).not.toHaveURL(settingsPathPattern)
  const url = new URL(page.url())
  expect(url.pathname === "/" || url.pathname === "").toBe(true)
})

Then("the browser location is the repos path", async ({ page }) => {
  await expect(page).toHaveURL(reposPathPattern)
})

Then(
  "the max concurrent Agent Turns field shows the saved value not {string}",
  async ({ page }, draft: string) => {
    const dialog = settingsDialog(page)
    await awaitCatalogSettled(dialog)
    const input = maxConcurrentTurnsInput(page)
    await expect(input).toBeVisible()
    await expect(input).not.toHaveValue(draft)
    // Default concurrency is 2 agent turns in a fresh harness.
    await expect(input).toHaveValue("2")
  },
)

Then("a settings save error is shown", async ({ page }) => {
  const dialog = settingsDialog(page)
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("alert")).toContainText(
    /Simulated settings save failure|could not be saved/i,
  )
})
