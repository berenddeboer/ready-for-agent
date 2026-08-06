/**
 * Rendered acceptance for catalog-only Agent Model selection (issue #838).
 *
 * The scenarios run against the live Harness with a deterministic fake `claude`
 * binary (no Anthropic login, no AWS call, no billable model) and the Harness
 * started without `CLAUDE_CODE_USE_BEDROCK`, so Claude Code is in first-party
 * configuration mode with its static alias catalog.
 *
 * A legacy Bedrock model is seeded straight into the database: the mutations now
 * refuse such a value, so GraphQL cannot produce the upgraded-installation state
 * these scenarios need. Assertions are on what the operator sees and can do —
 * the control type, the choices offered, whether Save is available, and what
 * guidance is shown.
 */

import { type Locator, type Page, expect } from "@playwright/test"
import { E2E_GRAPHQL_URL } from "../support/constants.ts"
import { dismissFirstRunSettingsIfPresent } from "../support/first-run-settings.ts"
import {
  CONTROL_FILES,
  type FakeClaudeMode,
  readGeneration,
  readLiveHarnessState,
  writeControlFile,
} from "../support/live-harness-control.ts"
import { Given, Then, When } from "./fixtures.ts"

/** Bedrock inference profile an operator had stored before switching modes. */
const LEGACY_BEDROCK_MODEL = "global.anthropic.claude-opus-5"
/** First-party Claude Code catalog (static aliases, no discovery). */
const CLAUDE_ALIASES = ["haiku", "sonnet", "opus", "fable"] as const
const CATALOG_UNAVAILABLE_SUFFIX = "(not in Agent Model catalog)"

const harnessDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Harness settings" })

/** The Repository settings dialog is titled with the Repository's path. */
const repositoryDialog = (page: Page) =>
  page.locator("dialog[open]").filter({ hasText: "Repository settings" })

const buildModelSelect = (dialog: Locator) =>
  dialog.locator('select[name="defaultModel"]')

const reviewModelSelect = (dialog: Locator) =>
  dialog.locator('select[name="reviewModel"]')

const optionLabels = async (select: Locator): Promise<readonly string[]> =>
  (await select.locator("option").allTextContents()).map((text) => text.trim())

const optionValues = async (select: Locator): Promise<readonly string[]> => {
  const options = select.locator("option")
  const count = await options.count()
  const values: string[] = []
  for (let index = 0; index < count; index += 1) {
    values.push((await options.nth(index).getAttribute("value")) ?? "")
  }
  return values
}

const awaitCatalogSettled = async (dialog: Locator) => {
  await expect(dialog.getByText("Loading settings...")).toHaveCount(0, {
    timeout: 60_000,
  })
  await expect(dialog.getByText("Loading models...")).toHaveCount(0, {
    timeout: 60_000,
  })
  await expect(dialog.getByText("Loading catalog…")).toHaveCount(0, {
    timeout: 60_000,
  })
}

const graphqlReachable = async (): Promise<boolean> => {
  try {
    const response = await fetch(E2E_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { config { defaultModel } }" }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Seed SQL against the *stopped* database, then restart and wait for the new
 * process to serve GraphQL again. The supervisor owns both the database file
 * and the child process, so steps only drop a request in its control directory.
 */
const seedAndRestart = async (sql: string) => {
  const state = readLiveHarnessState()
  const before = readGeneration(state)
  writeControlFile(state, CONTROL_FILES.seedSql, sql)
  writeControlFile(state, CONTROL_FILES.restart, "1")
  await expect
    .poll(() => readGeneration(state), { timeout: 60_000, intervals: [250] })
    .toBeGreaterThan(before)
  await expect
    .poll(graphqlReachable, { timeout: 120_000, intervals: [500] })
    .toBe(true)
}

const setClaudeMode = (mode: FakeClaudeMode) => {
  const state = readLiveHarnessState()
  writeControlFile(state, CONTROL_FILES.claudeMode, mode)
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

/**
 * Put the Harness on Claude Code with the given stored build model. Prefs are
 * keyed by the stable backend id `claude` and are not split by provider mode, so
 * a Bedrock profile stored in Bedrock mode is exactly what a first-party Harness
 * reads back — the stale-value case under test.
 */
const seedClaudeHarnessDefault = async (buildModel: string) => {
  const prefs = JSON.stringify({
    claude: {
      defaultModel: buildModel,
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
    },
  })
  await seedAndRestart(
    [
      "UPDATE config SET",
      "  selected_agent_backend = 'claude',",
      `  default_model = ${sqlLiteral(buildModel)},`,
      "  default_thinking_level = NULL,",
      "  review_model = NULL,",
      "  review_thinking_level = NULL,",
      `  backend_model_prefs = ${sqlLiteral(prefs)}`,
      "WHERE id = 'default';",
    ].join("\n"),
  )
  setClaudeMode("firstParty")
}

Given(
  "the Harness runs Claude Code with a legacy Bedrock Agent Model",
  async () => {
    await seedClaudeHarnessDefault(LEGACY_BEDROCK_MODEL)
  },
)

Given(
  "the Harness runs Claude Code with the {string} Agent Model",
  async (_fixtures, model: string) => {
    await seedClaudeHarnessDefault(model)
  },
)

When(
  "the Repository stores a legacy Bedrock Agent Model override",
  async () => {
    const prefs = JSON.stringify({
      claude: {
        defaultModel: LEGACY_BEDROCK_MODEL,
        defaultThinkingLevel: null,
        reviewModel: null,
        reviewThinkingLevel: null,
      },
    })
    // Inherit the harness Agent Backend (NULL override) so the Repository's
    // Effective backend is Claude Code and its catalog is the global one.
    await seedAndRestart(
      [
        "UPDATE repository SET",
        "  selected_agent_backend = NULL,",
        `  default_model = ${sqlLiteral(LEGACY_BEDROCK_MODEL)},`,
        "  default_thinking_level = NULL,",
        "  review_model = NULL,",
        "  review_thinking_level = NULL,",
        `  backend_model_prefs = ${sqlLiteral(prefs)};`,
      ].join("\n"),
    )
  },
)

const openHarnessSettings = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).first().click()
  const dialog = harnessDialog(page)
  await expect(dialog).toBeVisible()
  await awaitCatalogSettled(dialog)
}

When("I open Harness settings", async ({ page }) => {
  await page.goto("/")
  // A stale stored build model still counts as configured, so first-run
  // Settings does not auto-open; dismiss it only if it does.
  await dismissFirstRunSettingsIfPresent(page)
  await openHarnessSettings(page)
})

When("I reopen Harness settings", async ({ page }) => {
  // Deliberately no page.goto: the point is that this same long-lived client —
  // whose config/catalog/backend queries are cached indefinitely — re-fetches
  // provider mode and catalog when Settings opens (issue #838).
  await openHarnessSettings(page)
})

When("I close Harness settings", async ({ page }) => {
  const dialog = harnessDialog(page)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
})

When("I choose the build model {string}", async ({ page }, model: string) => {
  await buildModelSelect(harnessDialog(page)).selectOption(model)
})

When("I save Harness settings", async ({ page }) => {
  const dialog = harnessDialog(page)
  const save = dialog.getByRole("button", { name: "Save settings" })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
})

When(
  "Claude Code stops being authenticated and the Harness restarts",
  async () => {
    setClaudeMode("unauthenticated")
    // Restart with no seed: only the Agent Backend's readiness changed.
    await seedAndRestart("")
  },
)

When("I open Repository settings", async ({ page }) => {
  await page.goto("/repos")
  await dismissFirstRunSettingsIfPresent(page)
  await page
    .getByRole("button", { name: /^Actions for / })
    .first()
    .click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
  const dialog = repositoryDialog(page)
  await expect(dialog).toBeVisible()
  await awaitCatalogSettled(dialog)
})

When("I clear the Repository build model override", async ({ page }) => {
  // Clearing back to inheritance must stay reachable even while the stored
  // value is unavailable.
  await buildModelSelect(repositoryDialog(page)).selectOption("")
})

When("I save Repository settings", async ({ page }) => {
  const dialog = repositoryDialog(page)
  const save = dialog.getByRole("button", { name: "Save", exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
})

/**
 * Catalog-only means a real `<select>`: a control that cannot accept a typed
 * value at all. Editable inputs and `<datalist>` suggestions are what #838
 * removed, so their absence is asserted alongside the select's presence.
 */
const assertIsDropdown = async (dialog: Locator, select: Locator) => {
  await expect(select).toBeVisible()
  await expect(dialog.locator("datalist")).toHaveCount(0)
  await expect(dialog.locator('input[name="defaultModel"]')).toHaveCount(0)
  await expect(dialog.locator('input[name="reviewModel"]')).toHaveCount(0)
  await expect(dialog.locator("[list]")).toHaveCount(0)
}

Then(
  "the build model control is a dropdown, not a text box",
  async ({ page }) => {
    const dialog = harnessDialog(page)
    await assertIsDropdown(dialog, buildModelSelect(dialog))
  },
)

Then(
  "the review model control is a dropdown, not a text box",
  async ({ page }) => {
    const dialog = harnessDialog(page)
    await assertIsDropdown(dialog, reviewModelSelect(dialog))
  },
)

Then(
  "the Repository build model control is a dropdown, not a text box",
  async ({ page }) => {
    const dialog = repositoryDialog(page)
    await assertIsDropdown(dialog, buildModelSelect(dialog))
  },
)

Then(
  "the build model dropdown offers the first-party Claude aliases",
  async ({ page }) => {
    const values = await optionValues(buildModelSelect(harnessDialog(page)))
    for (const alias of CLAUDE_ALIASES) {
      expect(values).toContain(alias)
    }
  },
)

Then(
  "the build model dropdown offers no usable Agent Model",
  async ({ page }) => {
    const select = buildModelSelect(harnessDialog(page))
    const stored = await select.inputValue()
    // The only non-empty option left is the preserved stored value, and it is
    // marked unavailable — the catalog itself offers nothing to pick, so the
    // aliases the previous Harness process served are gone.
    expect(
      (await optionValues(select)).filter((value) => value.length > 0),
    ).toEqual([stored])
    expect(
      (await optionLabels(select)).find((label) => label.includes(stored)),
    ).toContain(CATALOG_UNAVAILABLE_SUFFIX)
  },
)

const expectUnavailableLegacyOption = async (select: Locator) => {
  // The stored value is preserved as a choice — never deleted or rewritten —
  // and is labelled so the operator understands why it cannot be used.
  await expect(select).toHaveValue(LEGACY_BEDROCK_MODEL)
  expect(await optionValues(select)).toContain(LEGACY_BEDROCK_MODEL)
  const labels = await optionLabels(select)
  expect(
    labels.some(
      (label) =>
        label.includes(LEGACY_BEDROCK_MODEL) &&
        label.includes(CATALOG_UNAVAILABLE_SUFFIX),
    ),
  ).toBe(true)
}

Then(
  "the build model dropdown shows the legacy Bedrock value as unavailable",
  async ({ page }) => {
    await expectUnavailableLegacyOption(buildModelSelect(harnessDialog(page)))
  },
)

Then(
  "the Repository build model dropdown shows the legacy Bedrock value as unavailable",
  async ({ page }) => {
    await expectUnavailableLegacyOption(
      buildModelSelect(repositoryDialog(page)),
    )
  },
)

Then("saving Harness settings is blocked", async ({ page }) => {
  await expect(
    harnessDialog(page).getByRole("button", { name: "Save settings" }),
  ).toBeDisabled()
})

Then("saving Harness settings is allowed", async ({ page }) => {
  await expect(
    harnessDialog(page).getByRole("button", { name: "Save settings" }),
  ).toBeEnabled()
})

Then("saving Repository settings is blocked", async ({ page }) => {
  await expect(
    repositoryDialog(page).getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled()
})

Then("saving Repository settings is allowed", async ({ page }) => {
  await expect(
    repositoryDialog(page).getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled()
})

Then(
  "the build model explains that the selection is not in the catalog",
  async ({ page }) => {
    await expect(
      harnessDialog(page).getByText(/not in the current Agent Model catalog/),
    ).toBeVisible()
  },
)

Then(
  "the build model dropdown has {string} selected",
  async ({ page }, model: string) => {
    await expect(buildModelSelect(harnessDialog(page))).toHaveValue(model)
  },
)

Then(
  "the Repository build model dropdown inherits the Harness default",
  async ({ page }) => {
    const select = buildModelSelect(repositoryDialog(page))
    await expect(select).toHaveValue("")
    // The placeholder names the inherited Harness default.
    expect((await optionLabels(select)).join(" ")).toContain("Harness default")
  },
)
