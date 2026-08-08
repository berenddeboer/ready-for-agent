/**
 * Playwright-BDD steps for routed Session Telemetry history
 * (issues #841 / #843).
 *
 * Shared navigation steps (home open, Back/Forward, refresh, first-run cancel,
 * Pipeline tab assertions) live in kanban-route / settings-browser-history.
 */
import { type Page, expect } from "@playwright/test"
import {
  TELEMETRY_FIXTURE,
  seedSessionTelemetryFixtures,
} from "../support/session-telemetry-fixture.ts"
import { Given, Then, When } from "./fixtures.ts"

const sessionUsageDialog = (page: Page) =>
  page.getByRole("dialog", { name: /Session$/ })

const telemetryPathFor = (workItemId: string): RegExp =>
  new RegExp(
    `/session/${workItemId.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}/telemetry/?(?:\\?.*)?$`,
  )

const completedPathPattern = /\/completed\/?(?:\?.*)?$/
const completedPageTwoPathPattern = /\/completed\/?\?page=2$/
const telemetryOriginScrollByPage = new WeakMap<Page, number>()

const openSessionButton = async (page: Page, sessionId: string) => {
  const sessionButton = page.getByRole("button", {
    name: sessionId,
    exact: true,
  })
  await expect(sessionButton).toBeVisible({ timeout: 30_000 })
  await sessionButton.click()
  const dialog = sessionUsageDialog(page)
  await expect(dialog).toBeVisible({ timeout: 15_000 })
}

type SessionQueryIntercept = {
  mode: "pass" | "fail" | "available"
}

const interceptByPage = new WeakMap<Page, SessionQueryIntercept>()

const interceptFor = (page: Page): SessionQueryIntercept => {
  let state = interceptByPage.get(page)
  if (state === undefined) {
    state = { mode: "pass" }
    interceptByPage.set(page, state)
  }
  return state
}

const installSessionQueryRoute = async (page: Page) => {
  await page.unroute("**/graphql").catch(() => {})
  await page.route("**/graphql", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") {
      await route.continue()
      return
    }
    let query = ""
    let variables: Record<string, unknown> = {}
    try {
      const body = request.postDataJSON() as {
        query?: string
        variables?: Record<string, unknown>
      }
      query = body.query ?? ""
      variables = body.variables ?? {}
    } catch {
      await route.continue()
      return
    }
    // Top-level session(workItemId: ...) query only — not Work Item sessionId.
    const isSessionTelemetryQuery =
      (/\bsession\s*\(/.test(query) || query.includes("session(")) &&
      (query.includes("workItemId") || variables.workItemId !== undefined) &&
      (query.includes("availability") || query.includes("tokens"))
    if (!isSessionTelemetryQuery) {
      await route.continue()
      return
    }

    const state = interceptFor(page)
    if (state.mode === "fail") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          errors: [{ message: "Simulated Session Telemetry failure" }],
        }),
      })
      return
    }

    if (state.mode === "available") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            session: {
              id: TELEMETRY_FIXTURE.missingSessionId,
              availability: "AVAILABLE",
              backend: { id: "opencode", label: "OpenCode" },
              model: {
                providerId: "openai",
                id: "gpt-e2e",
                thinkingLevel: "high",
              },
              tokens: {
                input: 100,
                output: 20,
                reasoning: 5,
                cacheRead: 50,
                cacheWrite: 10,
              },
              cost: 1.25,
              createdAt: "2026-07-14T08:00:00.000Z",
              updatedAt: "2026-07-14T09:00:00.000Z",
            },
          },
        }),
      })
      return
    }

    await route.continue()
  })
}

Given("the Harness has Session Telemetry fixtures", async () => {
  await seedSessionTelemetryFixtures()
})

When(
  "I open Session Telemetry for the missing-session fixture from Pipeline",
  async ({ page }) => {
    await installSessionQueryRoute(page)
    await openSessionButton(page, TELEMETRY_FIXTURE.missingSessionId)
  },
)

When(
  "I open Session Telemetry for the missing-session fixture from Repos",
  async ({ page }) => {
    await installSessionQueryRoute(page)
    await openSessionButton(page, TELEMETRY_FIXTURE.missingSessionId)
  },
)

When("I open the Completed page", async ({ page }) => {
  await page.goto("/completed")
  await expect(page).toHaveURL(completedPathPattern)
})

When("I open Completed page 2 directly", async ({ page }) => {
  await page.goto("/completed?page=2")
  await expect(page).toHaveURL(completedPageTwoPathPattern)
  await expect(
    page.getByRole("navigation", { name: "Completed work items pagination" }),
  ).toContainText("Page 2 of", { timeout: 30_000 })
})

When("I open Completed with invalid page search", async ({ page }) => {
  await page.goto("/completed?page=invalid")
})

When("I navigate to the next Completed page", async ({ page }) => {
  await page
    .getByRole("link", { name: "Next page of completed work items" })
    .click()
  await expect(page).toHaveURL(completedPageTwoPathPattern)
})

When(
  "I open Session Telemetry for the completed fixture from Completed",
  async ({ page }) => {
    await installSessionQueryRoute(page)
    await openSessionButton(page, TELEMETRY_FIXTURE.completedSessionId)
  },
)

When(
  "I open Session Telemetry for the page-2 fixture from Completed",
  async ({ page }) => {
    await installSessionQueryRoute(page)
    const sessionButton = page.getByRole("button", {
      name: TELEMETRY_FIXTURE.completedPageTwoSessionId,
      exact: true,
    })
    await expect(sessionButton).toBeVisible({ timeout: 30_000 })
    await sessionButton.scrollIntoViewIfNeeded()
    telemetryOriginScrollByPage.set(
      page,
      await page.evaluate(() => window.scrollY),
    )
    await sessionButton.click()
    await expect(sessionUsageDialog(page)).toBeVisible({ timeout: 15_000 })
  },
)

When("I press Escape", async ({ page }) => {
  await page.keyboard.press("Escape")
  await expect(sessionUsageDialog(page)).toBeHidden()
})

When(
  "I open the missing-session Session Telemetry path directly",
  async ({ page }) => {
    await installSessionQueryRoute(page)
    await page.goto(
      `/session/${TELEMETRY_FIXTURE.missingSessionWorkItemId}/telemetry`,
    )
    await expect(page).toHaveURL(
      telemetryPathFor(TELEMETRY_FIXTURE.missingSessionWorkItemId),
    )
    await expect(sessionUsageDialog(page)).toBeVisible({ timeout: 30_000 })
  },
)

When(
  "I open the unsupported Session Telemetry path directly",
  async ({ page }) => {
    await installSessionQueryRoute(page)
    await page.goto(
      `/session/${TELEMETRY_FIXTURE.unsupportedWorkItemId}/telemetry`,
    )
    await expect(page).toHaveURL(
      telemetryPathFor(TELEMETRY_FIXTURE.unsupportedWorkItemId),
    )
    await expect(sessionUsageDialog(page)).toBeVisible({ timeout: 30_000 })
  },
)

When(
  "I open Session Telemetry for a missing Work Item directly",
  async ({ page }) => {
    await installSessionQueryRoute(page)
    await page.goto("/session/wi-e2e-does-not-exist/telemetry")
    await expect(page).toHaveURL(telemetryPathFor("wi-e2e-does-not-exist"))
    await expect(sessionUsageDialog(page)).toBeVisible({ timeout: 30_000 })
  },
)

When("I close the Session usage dialog", async ({ page }) => {
  const dialog = sessionUsageDialog(page)
  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeHidden()
})

When("Session Telemetry query is forced to fail", async ({ page }) => {
  interceptFor(page).mode = "fail"
  await installSessionQueryRoute(page)
})

When(
  "Session Telemetry query returns available usage for the missing-session fixture",
  async ({ page }) => {
    interceptFor(page).mode = "available"
    await installSessionQueryRoute(page)
  },
)

Then(
  "the browser location is the Session Telemetry path for the missing-session fixture",
  async ({ page }) => {
    await expect(page).toHaveURL(
      telemetryPathFor(TELEMETRY_FIXTURE.missingSessionWorkItemId),
    )
  },
)

Then(
  "the browser location is the Session Telemetry path for the completed fixture",
  async ({ page }) => {
    await expect(page).toHaveURL(
      telemetryPathFor(TELEMETRY_FIXTURE.completedWorkItemId),
    )
  },
)

Then(
  "the browser location is the Session Telemetry path for the page-2 fixture",
  async ({ page }) => {
    await expect(page).toHaveURL(
      telemetryPathFor(TELEMETRY_FIXTURE.completedPageTwoWorkItemId),
    )
    expect(new URL(page.url()).searchParams.has("page")).toBe(false)
  },
)

Then(
  "the browser location is the Session Telemetry path for the missing-session fixture with theme dark",
  async ({ page }) => {
    await expect(page).toHaveURL(
      new RegExp(
        `/session/${TELEMETRY_FIXTURE.missingSessionWorkItemId}/telemetry/?\\?theme=dark$`,
      ),
    )
  },
)

Then("the browser location is the completed path", async ({ page }) => {
  await expect(page).toHaveURL(completedPathPattern)
})

Then("the browser location is Completed page 2", async ({ page }) => {
  await expect(page).toHaveURL(completedPageTwoPathPattern)
})

Then("the browser location is canonical Completed page 1", async ({ page }) => {
  await expect(page).toHaveURL(/\/completed\/?$/)
  await expect(
    page.getByRole("navigation", { name: "Completed work items pagination" }),
  ).toContainText("Page 1 of")
})

Then("Completed page 2 is visible", async ({ page }) => {
  await expect(
    page.getByRole("navigation", { name: "Completed work items pagination" }),
  ).toContainText("Page 2 of")
  await expect(
    page.getByRole("button", {
      name: TELEMETRY_FIXTURE.completedPageTwoSessionId,
      exact: true,
    }),
  ).toBeVisible()
})

Then("Completed page 2 remains visible under the dialog", async ({ page }) => {
  await expect(sessionUsageDialog(page)).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Completed work items pagination" }),
  ).toContainText("Page 2 of")
})

Then("the Completed jobs tab is active", async ({ page }) => {
  await expect(
    page.getByRole("navigation", { name: "Jobs" }).getByRole("link", {
      name: "Completed",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page")
})

Then("the Pipeline remains visible under the dialog", async ({ page }) => {
  await expect(
    page.getByRole("region", { name: "Lifecycle pipeline" }),
  ).toBeVisible()
})

Then("Repos remains visible under the dialog", async ({ page }) => {
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toBeVisible()
})

Then("the Completed scroll position is preserved", async ({ page }) => {
  const origin = telemetryOriginScrollByPage.get(page)
  if (origin === undefined) {
    throw new Error("Completed scroll origin was not recorded")
  }
  const current = await page.evaluate(() => window.scrollY)
  expect(origin).toBeGreaterThan(0)
  expect(current).toBe(origin)
})

Then("the Session usage dialog is visible", async ({ page }) => {
  await expect(sessionUsageDialog(page)).toBeVisible()
})

Then("the Session usage dialog is hidden", async ({ page }) => {
  await expect(sessionUsageDialog(page)).toBeHidden()
})

Then(
  "the Session usage dialog shows the missing Session Telemetry state",
  async ({ page }) => {
    const dialog = sessionUsageDialog(page)
    await expect(dialog.getByText("Loading usage…")).toHaveCount(0, {
      timeout: 30_000,
    })
    await expect(
      dialog.getByText(/no longer has this Session locally/i),
    ).toBeVisible({ timeout: 30_000 })
  },
)

Then(
  "the Session usage dialog shows the unsupported Session Telemetry state",
  async ({ page }) => {
    const dialog = sessionUsageDialog(page)
    await expect(dialog.getByText("Loading usage…")).toHaveCount(0, {
      timeout: 30_000,
    })
    await expect(
      dialog.getByText(/does not provide Session Telemetry/i),
    ).toBeVisible({ timeout: 30_000 })
  },
)

Then("the Session usage dialog shows Work Item not found", async ({ page }) => {
  const dialog = sessionUsageDialog(page)
  await expect(dialog.getByText("Loading usage…")).toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(dialog.getByText("Work Item not found.")).toBeVisible({
    timeout: 30_000,
  })
})

Then(
  "the Session usage dialog shows a Session usage load error",
  async ({ page }) => {
    const dialog = sessionUsageDialog(page)
    await expect(dialog.getByText("Loading usage…")).toHaveCount(0, {
      timeout: 30_000,
    })
    await expect(dialog.getByText(/Could not load Session usage/i)).toBeVisible(
      { timeout: 30_000 },
    )
  },
)

Then(
  "the Session usage dialog shows successful Session Telemetry fields",
  async ({ page }) => {
    const dialog = sessionUsageDialog(page)
    await expect(dialog.getByText("Loading usage…")).toHaveCount(0, {
      timeout: 30_000,
    })
    await expect(dialog.getByRole("row", { name: /Model/i })).toContainText(
      "gpt-e2e",
    )
    await expect(
      dialog.getByRole("row", { name: /Input tokens/i }),
    ).toContainText("100")
    await expect(dialog.getByRole("row", { name: /Cost/i })).toContainText(
      /1\.25|\$1\.25/,
    )
  },
)
