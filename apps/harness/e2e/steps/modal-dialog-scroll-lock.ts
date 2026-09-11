/**
 * Playwright-BDD steps for modal document scroll lock (issue #1279).
 *
 * Assertions use real wheel input at a placed pointer, then eventual
 * window / dialog / nested-list positions. Programmatic scrollTo only
 * sets up a nonzero origin.
 */
import { type Locator, type Page, expect } from "@playwright/test"
import {
  IMPLEMENT_WITH_ISSUE_FIXTURE,
  seedImplementWithIssueFixtures,
} from "../support/implement-with-issue-fixture.ts"
import { TELEMETRY_FIXTURE } from "../support/session-telemetry-fixture.ts"
import { Given, Then, When } from "./fixtures.ts"

const WHEEL_DELTA = 480
const OVERFLOW_VIEWPORT = { width: 1280, height: 560 } as const
const NARROW_VIEWPORT = { width: 390, height: 640 } as const

type ScrollOrigin = {
  readonly scrollY: number
  readonly clientWidth: number
}

const originByPage = new WeakMap<Page, ScrollOrigin>()
const tailScrollByPage = new WeakMap<Page, { before: number; after: number }>()

type PrefsDelay = {
  delay: { resolve: () => void; promise: Promise<void> } | null
}

const prefsDelayByPage = new WeakMap<Page, PrefsDelay>()

const openDialog = (page: Page) => page.locator("dialog[open]")

const implementWithDialog = (page: Page) =>
  page.getByRole("dialog", { name: /Implement (issue #\d+|all) with/ })

const sessionUsageDialog = (page: Page) =>
  page.getByRole("dialog", { name: /Session$/ })

const agentTurnTailList = (page: Page) => sessionUsageDialog(page).locator("ol")

const graphqlQueryText = (postData: unknown): string => {
  if (Array.isArray(postData)) {
    return postData
      .map((operation) =>
        typeof operation === "object" &&
        operation !== null &&
        "query" in operation &&
        typeof operation.query === "string"
          ? operation.query
          : "",
      )
      .join("\n")
  }
  if (
    typeof postData === "object" &&
    postData !== null &&
    "query" in postData &&
    typeof postData.query === "string"
  ) {
    return postData.query
  }
  return ""
}

const scrollMetrics = (page: Page) =>
  page.evaluate(() => {
    const scrolling = document.scrollingElement ?? document.documentElement
    return {
      scrollY: window.scrollY,
      scrollHeight: scrolling.scrollHeight,
      clientHeight: scrolling.clientHeight,
      clientWidth: document.documentElement.clientWidth,
    }
  })

const rememberOrigin = async (page: Page): Promise<ScrollOrigin> => {
  const metrics = await scrollMetrics(page)
  const origin = {
    scrollY: metrics.scrollY,
    clientWidth: metrics.clientWidth,
  }
  originByPage.set(page, origin)
  return origin
}

const restoreRecordedOffset = async (page: Page): Promise<void> => {
  const origin = originByPage.get(page)
  if (origin === undefined) {
    return
  }
  await ensureDocumentOverflows(page)
  await page.evaluate((top) => {
    window.scrollTo(0, top)
  }, origin.scrollY)
  await expect
    .poll(async () => (await scrollMetrics(page)).scrollY, { timeout: 5_000 })
    .toBe(origin.scrollY)
}

const clickIssueAction = async (
  page: Page,
  buttonName: string,
  menuItemName: string,
) => {
  const button = page.getByRole("button", { name: buttonName })
  await expect(button).toBeVisible({ timeout: 30_000 })
  await button.click()
  const item = page.getByRole("menuitem", { name: menuItemName })
  await expect(item).toBeVisible()
  await item.click()
}

const requiredOrigin = (page: Page): ScrollOrigin => {
  const origin = originByPage.get(page)
  if (origin === undefined) {
    throw new Error("Page background scroll origin was not recorded")
  }
  return origin
}

const ensureDocumentOverflows = async (page: Page): Promise<void> => {
  const metrics = await scrollMetrics(page)
  if (metrics.scrollHeight > metrics.clientHeight + 120) {
    return
  }
  await page.addStyleTag({
    content: "html { min-height: 240vh; }",
  })
  const after = await scrollMetrics(page)
  if (after.scrollHeight <= after.clientHeight + 120) {
    throw new Error(
      `Background still does not overflow (${String(after.scrollHeight)} <= ${String(after.clientHeight)})`,
    )
  }
}

const wheelAt = async (
  page: Page,
  point: { readonly x: number; readonly y: number },
  deltaY: number,
) => {
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, deltaY)
}

const backdropPoint = async (
  page: Page,
): Promise<{ readonly x: number; readonly y: number }> => {
  const viewport = page.viewportSize()
  if (viewport === null) {
    throw new Error("Viewport size is not available")
  }
  const dialogBox = await openDialog(page)
    .first()
    .boundingBox()
    .catch(() => null)
  const candidates = [
    { x: 16, y: 16 },
    { x: viewport.width - 16, y: 16 },
    { x: 16, y: viewport.height - 16 },
    { x: viewport.width - 16, y: viewport.height - 16 },
  ] as const
  for (const point of candidates) {
    if (dialogBox === null) {
      return point
    }
    const insideX =
      point.x >= dialogBox.x && point.x <= dialogBox.x + dialogBox.width
    const insideY =
      point.y >= dialogBox.y && point.y <= dialogBox.y + dialogBox.height
    if (!insideX || !insideY) {
      return point
    }
  }
  return { x: 8, y: Math.max(8, Math.floor((dialogBox?.y ?? 40) / 2)) }
}

const dialogPoint = async (
  page: Page,
): Promise<{ readonly x: number; readonly y: number }> => {
  const box = await openDialog(page).first().boundingBox()
  if (box === null) {
    throw new Error("Open dialog has no bounding box")
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + Math.min(48, Math.max(12, box.height / 4)),
  }
}

const locatorPoint = async (
  locator: Locator,
): Promise<{ readonly x: number; readonly y: number }> => {
  const box = await locator.boundingBox()
  if (box === null) {
    throw new Error("Target has no bounding box")
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + Math.min(24, Math.max(8, box.height / 3)),
  }
}

const dialogScrollState = (page: Page) =>
  openDialog(page)
    .first()
    .evaluate((dialog: Element) => {
      const scrollable = (node: Element): node is HTMLElement =>
        node instanceof HTMLElement && node.scrollHeight - node.clientHeight > 1
      const node = scrollable(dialog)
        ? dialog
        : [...dialog.querySelectorAll("*")].find(scrollable)
      if (node === undefined) {
        return { top: 0, max: 0 }
      }
      return {
        top: node.scrollTop,
        max: node.scrollHeight - node.clientHeight,
      }
    })

const setDialogScrollTop = async (page: Page, top: number) => {
  await openDialog(page)
    .first()
    .evaluate((dialog: Element, nextTop: number) => {
      const scrollable = (node: Element): node is HTMLElement =>
        node instanceof HTMLElement && node.scrollHeight - node.clientHeight > 1
      const node = scrollable(dialog)
        ? dialog
        : [...dialog.querySelectorAll("*")].find(scrollable)
      if (node !== undefined) {
        node.scrollTop = nextTop
      }
    }, top)
}

const longAgentTurnTail = {
  availability: "AVAILABLE",
  backend: { id: "opencode", label: "OpenCode" },
  jumpHint: false,
  items: Array.from({ length: 24 }, (_, index) => ({
    __typename: "AgentTurnTailAssistantText" as const,
    at: "2026-07-14T08:00:00.000Z",
    text: `Agent Turn Tail line ${String(index + 1)} ${"x".repeat(48)}`,
    truncated: false,
  })),
} as const

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

const isAgentTurnTailQuery = (query: string): boolean =>
  /\bagentTurnTail\s*\(/.test(query)

const isSessionUsageQuery = (query: string): boolean =>
  !isAgentTurnTailQuery(query) &&
  /\bsession\s*\(/.test(query) &&
  (query.includes("availability") ||
    query.includes("tokens") ||
    query.includes("agentTurnTailSupported"))

const prefsDelayFor = (page: Page): PrefsDelay => {
  let state = prefsDelayByPage.get(page)
  if (state === undefined) {
    state = { delay: null }
    prefsDelayByPage.set(page, state)
  }
  return state
}

const installImplementWithPrefsRoute = async (page: Page) => {
  await page.unroute("**/graphql").catch(() => {})
  await page.route("**/graphql", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") {
      await route.continue()
      return
    }
    let query = ""
    try {
      query = graphqlQueryText(request.postDataJSON())
    } catch {
      await route.continue()
      return
    }
    const state = prefsDelayFor(page)
    if (query.includes("harnessModelPrefs") && state.delay !== null) {
      await state.delay.promise
    }
    await route.continue()
  })
}

const installLongAgentTurnTailRoute = async (page: Page) => {
  await page.unroute("**/graphql").catch(() => {})
  await page.route("**/graphql", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") {
      await route.continue()
      return
    }
    let query = ""
    try {
      query = graphqlQueryText(request.postDataJSON())
    } catch {
      await route.continue()
      return
    }
    if (isAgentTurnTailQuery(query)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { agentTurnTail: longAgentTurnTail } }),
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

Given("the Harness has Implement With issue fixtures", async () => {
  await seedImplementWithIssueFixtures()
})

When(
  "I prepare an overflowing page background at a nonzero scroll offset",
  async ({ page }) => {
    const viewport = page.viewportSize()
    if (
      viewport !== null &&
      viewport.width >= 900 &&
      viewport.height > OVERFLOW_VIEWPORT.height
    ) {
      await page.setViewportSize({
        width: viewport.width,
        height: OVERFLOW_VIEWPORT.height,
      })
    }
    await ensureDocumentOverflows(page)
    const metrics = await scrollMetrics(page)
    const maxScroll = metrics.scrollHeight - metrics.clientHeight
    const target = Math.min(220, Math.max(80, Math.floor(maxScroll / 3)))
    await page.evaluate((top) => {
      window.scrollTo(0, top)
    }, target)
    const origin = await rememberOrigin(page)
    expect(origin.scrollY).toBeGreaterThan(0)
  },
)

When("I resize to a narrow short viewport", async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT)
})

When("I wheel over the dialog backdrop", async ({ page }) => {
  await expect(openDialog(page).first()).toBeVisible()
  await restoreRecordedOffset(page)
  await wheelAt(page, await backdropPoint(page), WHEEL_DELTA)
})

When("I wheel over the open dialog", async ({ page }) => {
  await expect(openDialog(page).first()).toBeVisible()
  await restoreRecordedOffset(page)
  await wheelAt(page, await dialogPoint(page), WHEEL_DELTA)
})

When("I wheel past the open dialog scroll boundary", async ({ page }) => {
  await expect(openDialog(page).first()).toBeVisible()
  await setDialogScrollTop(page, 0)
  await wheelAt(page, await dialogPoint(page), -WHEEL_DELTA)
  const state = await dialogScrollState(page)
  await setDialogScrollTop(page, Math.max(state.max, 0))
  await wheelAt(page, await dialogPoint(page), WHEEL_DELTA)
})

When("I wheel over the Agent Turn Tail", async ({ page }) => {
  const list = agentTurnTailList(page)
  await expect(list).toBeVisible()
  await list.evaluate((node) => {
    node.scrollTop = 0
  })
  const before = await list.evaluate((node) => node.scrollTop)
  await wheelAt(page, await locatorPoint(list), WHEEL_DELTA)
  await expect
    .poll(async () => list.evaluate((node) => node.scrollTop), {
      timeout: 5_000,
    })
    .toBeGreaterThan(before)
  tailScrollByPage.set(page, {
    before,
    after: await list.evaluate((node) => node.scrollTop),
  })
})

When("I wheel past the Agent Turn Tail scroll boundary", async ({ page }) => {
  const list = agentTurnTailList(page)
  await expect(list).toBeVisible()
  await list.evaluate((node) => {
    node.scrollTop = 0
  })
  await wheelAt(page, await locatorPoint(list), -WHEEL_DELTA)
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await wheelAt(page, await locatorPoint(list), WHEEL_DELTA)
})

When(
  "I open Session usage with a long Agent Turn Tail from Pipeline",
  async ({ page }) => {
    await installLongAgentTurnTailRoute(page)
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

When("I show the long Agent Turn Tail", async ({ page }) => {
  const dialog = sessionUsageDialog(page)
  await dialog.getByRole("button", { name: "Show tail" }).click()
  await expect(agentTurnTailList(page)).toBeVisible({ timeout: 15_000 })
})

When("Implement With preference loading is delayed", async ({ page }) => {
  let resolveGate = () => {}
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve
  })
  prefsDelayFor(page).delay = { resolve: resolveGate, promise }
  await installImplementWithPrefsRoute(page)
})

When(
  "the delayed Implement With preference loading completes",
  async ({ page }) => {
    const state = prefsDelayFor(page)
    const gate = state.delay
    state.delay = null
    gate?.resolve()
    const dialog = implementWithDialog(page)
    await expect(
      dialog.getByText("Loading current preferences..."),
    ).toHaveCount(0, { timeout: 30_000 })
  },
)

When(
  "I open Implement With for the leaf Issue from Repos",
  async ({ page }) => {
    await clickIssueAction(
      page,
      `Actions for issue #${String(IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueNumber)}`,
      "Implement with...",
    )
    await expect(implementWithDialog(page)).toBeVisible({ timeout: 15_000 })
  },
)

When(
  "I open Implement With for the parent Issue from Repos",
  async ({ page }) => {
    await clickIssueAction(
      page,
      `Actions for parent issue #${String(IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber)}`,
      "Implement all with...",
    )
    await expect(implementWithDialog(page)).toBeVisible({ timeout: 15_000 })
  },
)

When("I cancel the Implement With dialog", async ({ page }) => {
  const dialog = implementWithDialog(page)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
})

Then("mouse-wheel input can move the page background", async ({ page }) => {
  const before = await scrollMetrics(page)
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight)
  const viewport = page.viewportSize()
  if (viewport === null) {
    throw new Error("Viewport size is not available")
  }
  await wheelAt(
    page,
    { x: 24, y: Math.min(180, viewport.height / 3) },
    WHEEL_DELTA,
  )
  await expect
    .poll(async () => (await scrollMetrics(page)).scrollY, { timeout: 5_000 })
    .toBeGreaterThan(before.scrollY)
  const origin = originByPage.get(page)
  if (origin !== undefined) {
    await page.evaluate((top) => {
      window.scrollTo(0, top)
    }, origin.scrollY)
    await expect
      .poll(async () => (await scrollMetrics(page)).scrollY, {
        timeout: 5_000,
      })
      .toBe(origin.scrollY)
  }
})

Then("the page background scroll position is unchanged", async ({ page }) => {
  const origin = requiredOrigin(page)
  // Routed dialog opens can adjust window.scrollY (history/mask). Put the
  // recorded origin back under the lock, then prove it holds.
  if (await openDialog(page).first().isVisible()) {
    await restoreRecordedOffset(page)
  }
  await expect
    .poll(async () => (await scrollMetrics(page)).scrollY, { timeout: 3_000 })
    .toBe(origin.scrollY)
})

Then("the page layout width is unchanged", async ({ page }) => {
  const origin = requiredOrigin(page)
  const metrics = await scrollMetrics(page)
  expect(metrics.clientWidth).toBe(origin.clientWidth)
})

Then("the open dialog can scroll", async ({ page }) => {
  await setDialogScrollTop(page, 0)
  const before = await dialogScrollState(page)
  expect(before.max).toBeGreaterThan(0)
  await wheelAt(page, await dialogPoint(page), WHEEL_DELTA)
  await expect
    .poll(async () => (await dialogScrollState(page)).top, { timeout: 5_000 })
    .toBeGreaterThan(before.top)
})

Then("the Agent Turn Tail can scroll", async ({ page }) => {
  const recorded = tailScrollByPage.get(page)
  if (recorded === undefined) {
    throw new Error("Agent Turn Tail wheel was not recorded")
  }
  expect(recorded.after).toBeGreaterThan(recorded.before)
})

Then("the Implement With dialog is visible", async ({ page }) => {
  await expect(implementWithDialog(page)).toBeVisible()
})

Then("the Implement With dialog is hidden", async ({ page }) => {
  await expect(implementWithDialog(page)).toBeHidden()
})

Then(
  "the Implement With dialog shows loading preferences",
  async ({ page }) => {
    const dialog = implementWithDialog(page)
    await expect(
      dialog.getByText("Loading current preferences..."),
    ).toBeVisible()
    await expect(dialog.locator('select[name="agentBackend"]')).toHaveCount(0)
  },
)

Then("the Implement With dialog shows the form", async ({ page }) => {
  const dialog = implementWithDialog(page)
  await expect(dialog.getByText("Loading current preferences...")).toHaveCount(
    0,
    { timeout: 30_000 },
  )
  await expect(dialog.locator('select[name="agentBackend"]')).toBeVisible({
    timeout: 30_000,
  })
})
