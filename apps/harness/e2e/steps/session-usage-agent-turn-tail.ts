/**
 * Playwright-BDD steps for Session usage Agent Turn Tail (issue #1144).
 *
 * Session() stays cheap on open. agentTurnTail() is shaped to the idle
 * OpenCode Jump hint so the running UI can be checked without a local
 * OpenCode session store.
 */
import { type Page, expect } from "@playwright/test"
import { TELEMETRY_FIXTURE } from "../support/session-telemetry-fixture.ts"
import { Then, When } from "./fixtures.ts"

const sessionUsageDialog = (page: Page) =>
  page.getByRole("dialog", { name: /Session$/ })

const jumpHint =
  /No recent activity on this Session\. Child Sessions are not shown\. Use Jump\./

const isAgentTurnTailQuery = (query: string): boolean =>
  /\bagentTurnTail\s*\(/.test(query)

const isSessionUsageQuery = (query: string): boolean =>
  !isAgentTurnTailQuery(query) &&
  /\bsession\s*\(/.test(query) &&
  (query.includes("availability") ||
    query.includes("tokens") ||
    query.includes("agentTurnTailSupported"))

const availableIdleSession = {
  id: TELEMETRY_FIXTURE.idleSessionId,
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
  agentTurnTailSupported: true,
} as const

const idleAgentTurnTail = {
  availability: "AVAILABLE",
  backend: { id: "opencode", label: "OpenCode" },
  jumpHint: true,
  items: [],
} as const

const installIdleTailRoute = async (page: Page) => {
  await page.unroute("**/graphql").catch(() => {})
  await page.route("**/graphql", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") {
      await route.continue()
      return
    }
    let query = ""
    try {
      const body = request.postDataJSON() as {
        query?: string
      }
      query = body.query ?? ""
    } catch {
      await route.continue()
      return
    }

    if (isAgentTurnTailQuery(query)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { agentTurnTail: idleAgentTurnTail } }),
      })
      return
    }

    if (isSessionUsageQuery(query)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { session: availableIdleSession } }),
      })
      return
    }

    await route.continue()
  })
}

When(
  "I open Session usage for the idle OpenCode Session from Pipeline",
  async ({ page }) => {
    await installIdleTailRoute(page)
    const sessionButton = page.getByRole("button", {
      name: TELEMETRY_FIXTURE.idleSessionId,
      exact: true,
    })
    await expect(sessionButton).toBeVisible({ timeout: 30_000 })
    await sessionButton.click()
    const dialog = sessionUsageDialog(page)
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByText("Loading usage…")).toHaveCount(0, {
      timeout: 30_000,
    })
  },
)

When("I show the Agent Turn Tail", async ({ page }) => {
  const dialog = sessionUsageDialog(page)
  await dialog.getByRole("button", { name: "Show tail" }).click()
  await expect(dialog.getByText(jumpHint)).toBeVisible({ timeout: 15_000 })
})

When("I refresh the Agent Turn Tail", async ({ page }) => {
  const dialog = sessionUsageDialog(page)
  await dialog.getByRole("button", { name: "Refresh" }).click()
  await expect(dialog.getByText(jumpHint)).toBeVisible({ timeout: 15_000 })
})

Then("the Session usage dialog shows Show tail", async ({ page }) => {
  await expect(
    sessionUsageDialog(page).getByRole("button", { name: "Show tail" }),
  ).toBeVisible()
})

Then("the Session usage dialog does not show Show tail", async ({ page }) => {
  const dialog = sessionUsageDialog(page)
  await expect(dialog.getByText("Loading usage…")).toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(dialog.getByRole("button", { name: "Show tail" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Refresh" })).toHaveCount(0)
})

Then(
  "the Session usage dialog does not show Agent Turn Tail",
  async ({ page }) => {
    const dialog = sessionUsageDialog(page)
    await expect(dialog.getByText("Loading tail…")).toHaveCount(0)
    await expect(dialog.getByText(jumpHint)).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Refresh" })).toHaveCount(0)
  },
)

Then("the Session usage dialog shows the empty Jump hint", async ({ page }) => {
  const dialog = sessionUsageDialog(page)
  await expect(dialog.getByText(jumpHint)).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Refresh" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Show tail" })).toHaveCount(0)
})
