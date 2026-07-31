import { type Page, expect } from "@playwright/test"
import { E2E_GRAPHQL_URL } from "./constants.ts"

export const settingsDialog = (page: Page) =>
  page.getByRole("dialog", {
    name: "Harness settings",
  })

const pageLandmark = (page: Page) =>
  page
    .getByRole("heading", { name: "No repositories configured" })
    .or(page.getByRole("region", { name: "Lifecycle pipeline" }))
    .or(page.getByRole("region", { name: "Configured repositories" }))

/** True when harness has no default build model (first-run Settings auto-opens). */
const isFirstRunSettingsRequired = async (): Promise<boolean> => {
  const response = await fetch(E2E_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query { config { defaultModel } }`,
    }),
  })
  if (!response.ok) {
    throw new Error(
      `GraphQL HTTP ${response.status} while checking first-run settings: ${await response.text()}`,
    )
  }
  const payload = (await response.json()) as {
    data?: { config?: { defaultModel: string | null } }
    errors?: ReadonlyArray<{ message: string }>
  }
  if (payload.errors?.length) {
    throw new Error(
      `GraphQL errors while checking first-run settings: ${payload.errors
        .map((e) => e.message)
        .join("; ")}`,
    )
  }
  const defaultModel = payload.data?.config?.defaultModel
  return (
    defaultModel === null ||
    defaultModel === undefined ||
    defaultModel.length === 0
  )
}

/**
 * First-run Settings auto-opens after config loads when no default build
 * model is set. After Save (or when already configured), it does not.
 * Cancel only when present so multi-scenario e2e stays stable.
 *
 * Gates the late wait on GraphQL config: when a build model is already set,
 * skip the auto-open poll entirely. When first-run is required, wait for the
 * dialog (config may load after landmarks paint) then Cancel.
 */
export const dismissFirstRunSettingsIfPresent = async (page: Page) => {
  const dialog = settingsDialog(page)
  const landmark = pageLandmark(page)

  await expect(dialog.or(landmark)).toBeVisible({ timeout: 30_000 })

  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
    return
  }

  const firstRunRequired = await isFirstRunSettingsRequired()
  if (!firstRunRequired) {
    // Configured: auto-open will not run — do not burn a late-dialog timeout.
    await expect(dialog).toBeHidden()
    return
  }

  // Unconfigured: landmarks may paint before config; wait for auto-open.
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
}

/**
 * Complete first-run settings: prefer OpenCode when listed (shared e2e
 * default), otherwise keep the current backend; pick a build model from the
 * live catalog; Save.
 */
export const completeAndSaveFirstRunSettings = async (page: Page) => {
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Loading settings...")).toHaveCount(0, {
    timeout: 30_000,
  })

  const backendSelect = dialog.locator('select[name="selectedAgentBackend"]')
  await expect(backendSelect).toBeVisible()
  await expect
    .poll(async () => backendSelect.locator("option").count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)

  // Prefer opencode (usual harness default) when present so a prior first-run
  // reset that switched backends does not leave the suite on an alternate.
  const opencodeOption = backendSelect.locator('option[value="opencode"]')
  if ((await opencodeOption.count()) > 0) {
    await backendSelect.selectOption("opencode")
  } else {
    const current = await backendSelect.inputValue()
    if (current.length === 0) {
      const firstValue = await backendSelect
        .locator("option")
        .first()
        .getAttribute("value")
      if (firstValue != null && firstValue.length > 0) {
        await backendSelect.selectOption(firstValue)
      }
    }
  }

  // Backend change may re-load the model catalog via preview.
  await expect(dialog.getByText("Loading settings...")).toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(dialog.getByText("Loading catalog…")).toHaveCount(0, {
    timeout: 30_000,
  })

  const modelSelect = dialog.locator('select[name="defaultModel"]')
  await expect(modelSelect).toBeVisible()
  // Wait until catalog options exist beyond the empty placeholder.
  await expect
    .poll(
      async () => {
        const options = modelSelect.locator("option")
        const count = await options.count()
        if (count === 0) return 0
        let real = 0
        for (let i = 0; i < count; i += 1) {
          const value = await options.nth(i).getAttribute("value")
          if (value != null && value.length > 0) real += 1
        }
        return real
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)

  const modelOptions = modelSelect.locator("option")
  const modelCount = await modelOptions.count()
  let selectedModel: string | null = null
  for (let i = 0; i < modelCount; i += 1) {
    const value = await modelOptions.nth(i).getAttribute("value")
    if (value != null && value.length > 0) {
      selectedModel = value
      break
    }
  }
  if (selectedModel === null) {
    throw new Error(
      "Harness settings has no build model options for the isolated e2e backend catalog",
    )
  }
  await modelSelect.selectOption(selectedModel)

  const saveButton = dialog.getByRole("button", { name: "Save settings" })
  await expect(saveButton).toBeEnabled({ timeout: 15_000 })
  await saveButton.click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
}
