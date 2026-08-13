import { type Page, expect } from "@playwright/test"
import { E2E_GRAPHQL_URL } from "./constants.ts"
import {
  CONTROL_FILES,
  readLiveHarnessState,
  writeControlFile,
} from "./live-harness-control.ts"
import { seedLiveHarnessAndRestart } from "./live-harness-seed.ts"

export type DefaultBuildModelCatalogResolution =
  | { readonly kind: "already-configured" }
  | { readonly kind: "configure"; readonly modelId: string }
  | { readonly kind: "empty-catalog" }

/**
 * Decide whether Config already has a usable catalog model, needs an
 * update, or has no catalog at all (typically leftover unauthenticated
 * fake Claude from a prior live-e2e scenario).
 */
export const resolveDefaultBuildModelFromCatalog = (input: {
  readonly current: string | null
  readonly models: ReadonlyArray<{ readonly id: string }>
}): DefaultBuildModelCatalogResolution => {
  const catalogIds = input.models
    .map((model) => model.id)
    .filter((id) => id.length > 0)
  if (
    input.current !== null &&
    input.current.length > 0 &&
    catalogIds.includes(input.current)
  ) {
    return { kind: "already-configured" }
  }
  const modelId = catalogIds[0]
  if (modelId === undefined) {
    return { kind: "empty-catalog" }
  }
  return { kind: "configure", modelId }
}

/**
 * First-run Save still prefers OpenCode when listed, then tries the other
 * backends so an unauthenticated / inspect-failed OpenCode does not stall
 * on an empty catalog (CI ui-history).
 */
export const preferredFirstRunBackendIds = (
  backendIds: readonly string[],
): readonly string[] => {
  const available = backendIds.filter((id) => id.length > 0)
  const preferred = available.filter((id) => id === "opencode")
  const rest = available.filter((id) => id !== "opencode")
  return [...preferred, ...rest]
}

const restoreFakeClaudeFirstParty = async (): Promise<void> => {
  const state = readLiveHarnessState()
  writeControlFile(state, CONTROL_FILES.claudeMode, "firstParty")
  await seedLiveHarnessAndRestart("")
}

export const settingsDialog = (page: Page) =>
  page.getByRole("dialog", {
    name: "Harness settings",
  })

const pageLandmark = (page: Page) =>
  page
    .getByRole("heading", { name: "No repositories configured" })
    .or(page.getByRole("region", { name: "Lifecycle pipeline" }))
    .or(page.getByRole("region", { name: "Configured repositories" }))
    // Completed archive body (issue #843 Session Telemetry origin).
    .or(page.getByRole("list", { name: "All completed work items" }))
    .or(
      page.getByRole("status").filter({
        hasText: /No completed work items|Loading completed work items/i,
      }),
    )

const graphqlJson = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(E2E_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    throw new Error(
      `GraphQL HTTP ${response.status} while preparing settings: ${await response.text()}`,
    )
  }
  const payload = (await response.json()) as {
    data?: T
    errors?: ReadonlyArray<{ message: string }>
  }
  if (payload.errors?.length) {
    throw new Error(
      `GraphQL errors while preparing settings: ${payload.errors
        .map((e) => e.message)
        .join("; ")}`,
    )
  }
  if (payload.data === undefined) {
    throw new Error("GraphQL response missing data while preparing settings")
  }
  return payload.data
}

/** True when harness has no default build model (first-run Settings auto-opens). */
const isFirstRunSettingsRequired = async (): Promise<boolean> => {
  const data = await graphqlJson<{
    config: { defaultModel: string | null }
  }>(`query { config { defaultModel } }`)
  const defaultModel = data.config.defaultModel
  return (
    defaultModel === null ||
    defaultModel === undefined ||
    defaultModel.length === 0
  )
}

type ConfigAndModels = {
  readonly config: {
    readonly selectedAgentBackend: string
    readonly defaultModel: string | null
    readonly maxConcurrentAgentTurns: number
    readonly maxConcurrentWorkItems: number
  }
  readonly models: ReadonlyArray<{ readonly id: string }>
}

const fetchConfigAndModels = async (): Promise<ConfigAndModels> =>
  graphqlJson<ConfigAndModels>(`query {
    config {
      selectedAgentBackend
      defaultModel
      maxConcurrentAgentTurns
      maxConcurrentWorkItems
    }
    models { id }
  }`)

/**
 * Ensure Harness Config has a catalog build model so Save is not blocked by
 * first-run emptiness. Used by history scenarios that cancel first-run and
 * then Save (issue #840 review) — independent of suite order.
 *
 * When a prior live-e2e scenario left fake Claude unauthenticated (empty
 * catalog), restore first-party readiness and retry once so later
 * `@live-forge` scenarios such as Intake still have a usable catalog.
 */
export const ensureConfiguredDefaultBuildModel = async (): Promise<void> => {
  let data = await fetchConfigAndModels()
  let resolution = resolveDefaultBuildModelFromCatalog({
    current: data.config.defaultModel,
    models: data.models,
  })
  if (resolution.kind === "empty-catalog") {
    await restoreFakeClaudeFirstParty()
    data = await fetchConfigAndModels()
    resolution = resolveDefaultBuildModelFromCatalog({
      current: data.config.defaultModel,
      models: data.models,
    })
  }
  if (resolution.kind === "already-configured") {
    return
  }
  if (resolution.kind === "empty-catalog") {
    throw new Error(
      "Cannot configure default build model: Agent Model catalog is empty",
    )
  }

  const updated = await graphqlJson<{
    updateConfig: { defaultModel: string | null }
  }>(
    `mutation UpdateConfig($input: UpdateConfigInput!) {
      updateConfig(input: $input) {
        defaultModel
      }
    }`,
    {
      input: {
        selectedAgentBackend: data.config.selectedAgentBackend,
        defaultModel: resolution.modelId,
        defaultThinkingLevel: null,
        reviewModel: null,
        reviewThinkingLevel: null,
        maxConcurrentAgentTurns: data.config.maxConcurrentAgentTurns,
        maxConcurrentWorkItems: data.config.maxConcurrentWorkItems,
      },
    },
  )

  if (
    updated.updateConfig.defaultModel === null ||
    updated.updateConfig.defaultModel.length === 0
  ) {
    throw new Error(
      `Expected non-empty defaultModel after configure, got ${JSON.stringify(updated.updateConfig.defaultModel)}`,
    )
  }
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

  // First-run Settings can sit on top of Repos/Pipeline. `dialog.or(landmark)`
  // then matches two elements and Playwright's strict `toBeVisible` fails.
  await expect
    .poll(
      async () => (await dialog.isVisible()) || (await landmark.isVisible()),
      { timeout: 30_000 },
    )
    .toBe(true)

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

const listedSelectValues = async (
  select: ReturnType<Page["locator"]>,
): Promise<readonly string[]> => {
  const options = select.locator("option")
  const count = await options.count()
  const values: string[] = []
  for (let i = 0; i < count; i += 1) {
    const value = await options.nth(i).getAttribute("value")
    if (value != null && value.length > 0) {
      values.push(value)
    }
  }
  return values
}

const countRealSelectValues = async (
  select: ReturnType<Page["locator"]>,
): Promise<number> => (await listedSelectValues(select)).length

/**
 * Complete first-run settings: prefer OpenCode when listed (shared e2e
 * default), then fall back to another listed backend whose catalog has a
 * build model; pick that model; Save.
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

  const modelSelect = dialog.locator('select[name="defaultModel"]')
  await expect(modelSelect).toBeVisible()

  const backendIds = preferredFirstRunBackendIds(
    await listedSelectValues(backendSelect),
  )
  let selectedModel: string | null = null
  for (const backendId of backendIds) {
    await backendSelect.selectOption(backendId)
    // Backend change may re-load the model catalog via preview.
    await expect(dialog.getByText("Loading settings...")).toHaveCount(0, {
      timeout: 30_000,
    })
    await expect(dialog.getByText("Loading catalog…")).toHaveCount(0, {
      timeout: 30_000,
    })
    try {
      await expect
        .poll(() => countRealSelectValues(modelSelect), {
          timeout: 15_000,
        })
        .toBeGreaterThan(0)
    } catch {
      continue
    }
    const catalog = await listedSelectValues(modelSelect)
    selectedModel = catalog[0] ?? null
    if (selectedModel !== null) {
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
