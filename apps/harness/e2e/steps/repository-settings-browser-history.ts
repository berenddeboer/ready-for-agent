/**
 * Playwright-BDD steps for routed Repository settings history (issue #842).
 */
import { type Page, expect } from "@playwright/test"
import { E2E_GRAPHQL_URL } from "../support/constants.ts"
import { dismissFirstRunSettingsIfPresent } from "../support/first-run-settings.ts"
import { Then, When } from "./fixtures.ts"

/** Repository settings dialog is titled with the Project Path. */
const repositoryDialog = (page: Page) =>
  page.locator("dialog[open]").filter({ hasText: "Repository settings" })

const notFoundDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Repository not found" })

const awaitCatalogSettled = async (
  dialog: ReturnType<typeof repositoryDialog>,
) => {
  await expect(dialog.getByText("Loading models...")).toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(dialog.getByText("Loading catalog…")).toHaveCount(0, {
    timeout: 30_000,
  })
}

const repositorySettingsPathPattern = /\/repos\/[^/]+\/settings\/?(?:\?.*)?$/

const fetchFirstRepositoryId = async (): Promise<string> => {
  const response = await fetch(E2E_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "query { repositories { id projectPath } }",
    }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as {
    data?: { repositories: ReadonlyArray<{ id: string; projectPath: string }> }
    errors?: ReadonlyArray<{ message: string }>
  }
  if (payload.errors?.length) {
    throw new Error(
      `GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`,
    )
  }
  const repositories = payload.data?.repositories ?? []
  const first = repositories[0]
  if (first === undefined) {
    throw new Error("Expected at least one configured Repository")
  }
  return first.id
}

type UpdateRepositorySettingsIntercept = {
  failNext: boolean
  delay: { resolve: () => void; promise: Promise<void> } | null
}

const interceptByPage = new WeakMap<Page, UpdateRepositorySettingsIntercept>()

const interceptFor = (page: Page): UpdateRepositorySettingsIntercept => {
  let state = interceptByPage.get(page)
  if (state === undefined) {
    state = { failNext: false, delay: null }
    interceptByPage.set(page, state)
  }
  return state
}

const installUpdateRepositorySettingsRoute = async (page: Page) => {
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
    if (!query.includes("updateRepositorySettings")) {
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
          errors: [{ message: "Simulated repository settings save failure" }],
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

When("I open the Repos page with theme dark", async ({ page }) => {
  await page.goto("/repos?theme=dark")
  await expect(page).toHaveURL(/theme=dark/)
  await dismissFirstRunSettingsIfPresent(page)
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toBeVisible({ timeout: 30_000 })
})

When("I open Repository settings from the card menu", async ({ page }) => {
  await installUpdateRepositorySettingsRoute(page)
  // Ensure we are on Repos with cards (callers usually open Repos first).
  if (!/\/repos/.test(new URL(page.url()).pathname)) {
    await page.goto("/repos")
    await dismissFirstRunSettingsIfPresent(page)
  }
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toBeVisible({ timeout: 30_000 })
  await page
    .getByRole("button", { name: /^Actions for / })
    .first()
    .click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const dialog = repositoryDialog(page)
  await expect(dialog).toBeVisible()
  await awaitCatalogSettled(dialog)
})

When("I open the repository settings path directly", async ({ page }) => {
  await installUpdateRepositorySettingsRoute(page)
  const repositoryId = await fetchFirstRepositoryId()
  await page.goto(`/repos/${encodeURIComponent(repositoryId)}/settings`)
  await expect(page).toHaveURL(repositorySettingsPathPattern)
  const dialog = repositoryDialog(page)
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await awaitCatalogSettled(dialog)
})

When("I open a stale repository settings path", async ({ page }) => {
  await page.goto("/repos/repo-stale-missing-id/settings")
  await expect(page).toHaveURL(repositorySettingsPathPattern)
  await dismissFirstRunSettingsIfPresent(page)
})

When("I cancel the Repository settings dialog", async ({ page }) => {
  const dialog = repositoryDialog(page)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
})

When("I press Escape in the Repository settings dialog", async ({ page }) => {
  const dialog = repositoryDialog(page)
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

When("I change the Repository paused draft", async ({ page }) => {
  const dialog = repositoryDialog(page)
  const checkbox = dialog.getByRole("checkbox", { name: /Paused/i })
  await expect(checkbox).toBeVisible()
  const wasChecked = await checkbox.isChecked()
  await checkbox.setChecked(!wasChecked)
  // Stash the draft expectation on the page for the Then step.
  await page.evaluate((draftChecked) => {
    ;(window as unknown as { __rfaPausedDraft?: boolean }).__rfaPausedDraft =
      draftChecked
  }, !wasChecked)
})

When(
  "I go back in the browser while Repository settings Save is pending",
  async ({ page }) => {
    await page.evaluate(() => {
      window.history.back()
    })
    await expect(page).toHaveURL(repositorySettingsPathPattern)
    await expect
      .poll(
        async () => {
          const dialog = repositoryDialog(page)
          const dialogOpen = await dialog.isVisible()
          const saving = await dialog
            .getByRole("button", { name: "Saving…" })
            .isVisible()
            .catch(() => false)
          const onSettings = repositorySettingsPathPattern.test(
            new URL(page.url()).pathname,
          )
          return dialogOpen && saving && onSettings
        },
        { timeout: 5_000 },
      )
      .toBe(true)
  },
)

When("I save Repository settings without changing values", async ({ page }) => {
  const dialog = repositoryDialog(page)
  await awaitCatalogSettled(dialog)
  const save = dialog.getByRole("button", { name: "Save", exact: true })
  await expect(save).toBeEnabled({ timeout: 15_000 })
  await save.click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
})

When("Repository settings Save is forced to fail", async ({ page }) => {
  interceptFor(page).failNext = true
  await installUpdateRepositorySettingsRoute(page)
})

When("I save Repository settings expecting failure", async ({ page }) => {
  const dialog = repositoryDialog(page)
  await awaitCatalogSettled(dialog)
  const save = dialog.getByRole("button", { name: "Save", exact: true })
  await expect(save).toBeEnabled({ timeout: 15_000 })
  await save.click()
  await expect(dialog).toBeVisible()
})

When("Repository settings Save is delayed", async ({ page }) => {
  let resolveGate = () => {}
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve
  })
  interceptFor(page).delay = { resolve: resolveGate, promise }
  await installUpdateRepositorySettingsRoute(page)
})

When("I start saving Repository settings", async ({ page }) => {
  const dialog = repositoryDialog(page)
  await awaitCatalogSettled(dialog)
  const save = dialog.getByRole("button", { name: "Save", exact: true })
  await expect(save).toBeEnabled({ timeout: 15_000 })
  await save.click()
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeVisible({
    timeout: 15_000,
  })
})

When("the delayed Repository settings Save completes", async ({ page }) => {
  const state = interceptFor(page)
  const gate = state.delay
  state.delay = null
  gate?.resolve()
  const dialog = repositoryDialog(page)
  await expect(dialog).toBeHidden({ timeout: 60_000 })
})

When("I close the Repository not found dialog", async ({ page }) => {
  const dialog = notFoundDialog(page)
  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeHidden()
})

Then(
  "the browser location is the repository settings path",
  async ({ page }) => {
    await expect(page).toHaveURL(repositorySettingsPathPattern)
    const pathname = new URL(page.url()).pathname
    // Path must use the stable Repository ID (repo-…), not a nested project path.
    expect(pathname).toMatch(/^\/repos\/repo-[^/]+\/settings\/?$/)
  },
)

Then(
  "the browser location is the repository settings path with theme dark",
  async ({ page }) => {
    await expect(page).toHaveURL(/\/repos\/[^/]+\/settings\/?\?theme=dark$/)
  },
)

Then("the browser location is a repository settings path", async ({ page }) => {
  await expect(page).toHaveURL(repositorySettingsPathPattern)
})

Then("the Repository settings dialog is visible", async ({ page }) => {
  const dialog = repositoryDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Repository not found")).toHaveCount(0)
})

Then("the Repository settings dialog is hidden", async ({ page }) => {
  await expect(repositoryDialog(page)).toBeHidden()
})

Then("the Repository not found dialog is visible", async ({ page }) => {
  await expect(notFoundDialog(page)).toBeVisible({ timeout: 30_000 })
  await expect(notFoundDialog(page).getByRole("alert")).toBeVisible()
})

Then("the Repository not found dialog is hidden", async ({ page }) => {
  await expect(notFoundDialog(page)).toBeHidden()
})

Then("the Repos jobs tab is active", async ({ page }) => {
  const reposTab = page
    .getByRole("navigation", { name: "Jobs" })
    .getByRole("link", { name: "Repos" })
  await expect(reposTab).toHaveAttribute("aria-current", "page")
})

Then(
  "the Repository paused field shows the saved value not the draft",
  async ({ page }) => {
    const dialog = repositoryDialog(page)
    await awaitCatalogSettled(dialog)
    const checkbox = dialog.getByRole("checkbox", { name: /Paused/i })
    await expect(checkbox).toBeVisible()
    const draftChecked = await page.evaluate(
      () =>
        (window as unknown as { __rfaPausedDraft?: boolean }).__rfaPausedDraft,
    )
    // Fresh fixture repos are not paused; draft flipped that, so saved is opposite.
    if (draftChecked === true) {
      await expect(checkbox).not.toBeChecked()
    } else if (draftChecked === false) {
      await expect(checkbox).toBeChecked()
    } else {
      // Default fixture: not paused after discarded draft.
      await expect(checkbox).not.toBeChecked()
    }
  },
)

Then("a repository settings save error is shown", async ({ page }) => {
  const dialog = repositoryDialog(page)
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("alert")).toContainText(
    /Simulated repository settings save failure|could not be saved/i,
  )
})

// Reuse shared "I go back/forward" and "I refresh" from settings-browser-history
// and "browser location is the repos path" from the same module. Playwright-BDD
// collects all step files.
