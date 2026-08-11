/**
 * Live e2e for default Agent Backend availability without OpenCode (#958).
 *
 * Runs under `E2E_AGENT_BACKEND_MODE=no-opencode` + `KEYMAXXER_ENABLED=false`
 * (`harness:e2e-no-backend`). The supervisor strips ambient `opencode` from
 * the product PATH and soft-disables Keymaxxer; these steps only control the
 * fake Claude readiness and assert GraphQL + first-run UI guidance.
 */

import { type Page, expect } from "@playwright/test"
import { E2E_GRAPHQL_URL } from "../support/constants.ts"
import { settingsDialog } from "../support/first-run-settings.ts"
import {
  CONTROL_FILES,
  type FakeClaudeMode,
  readGeneration,
  readLiveHarnessState,
  writeControlFile,
} from "../support/live-harness-control.ts"
import { Given, Then, When } from "./fixtures.ts"

type GraphqlEnvelope<T> = {
  data?: T
  errors?: ReadonlyArray<{ message: string }>
}

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
    throw new Error(`GraphQL HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as GraphqlEnvelope<T>
  if (payload.errors?.length) {
    throw new Error(
      `GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`,
    )
  }
  if (payload.data === undefined) {
    throw new Error("GraphQL response missing data")
  }
  return payload.data
}

const graphqlReachable = async (): Promise<boolean> => {
  try {
    const data = await graphqlJson<{ health: boolean }>(`query { health }`)
    return data.health === true
  } catch {
    return false
  }
}

const setClaudeModeAndRestart = async (mode: FakeClaudeMode) => {
  const state = readLiveHarnessState()
  const before = readGeneration(state)
  writeControlFile(state, CONTROL_FILES.claudeMode, mode)
  // Empty seed: only fake-CLI readiness changed.
  writeControlFile(state, CONTROL_FILES.seedSql, "")
  writeControlFile(state, CONTROL_FILES.restart, "1")
  await expect
    .poll(() => readGeneration(state), { timeout: 60_000, intervals: [250] })
    .toBeGreaterThan(before)
  await expect
    .poll(graphqlReachable, { timeout: 120_000, intervals: [500] })
    .toBe(true)
}

Given("Claude Code reports unauthenticated", async () => {
  await setClaudeModeAndRestart("unauthenticated")
})

Given("Claude Code reports first-party authenticated", async () => {
  await setClaudeModeAndRestart("firstParty")
})

/**
 * First-run / Unavailable-backend Settings auto-opens. Dismiss it so the
 * page-shell banner (issue #937 guidance) is visible for UI assertions.
 */
const openHomeAndDismissAutoSettings = async (page: Page) => {
  await page.goto("/")
  const dialog = settingsDialog(page)
  const landmark = page
    .getByRole("heading", { name: "No repositories configured" })
    .or(page.getByRole("region", { name: "Lifecycle pipeline" }))
    .or(page.getByRole("region", { name: "Configured repositories" }))

  await expect(dialog.or(landmark)).toBeVisible({ timeout: 60_000 })

  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
  } else {
    // Config / backend status may still be loading; wait for auto-open then dismiss.
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
  }
}

When(
  "I open the home page for default-backend first-run guidance",
  async ({ page }) => {
    await openHomeAndDismissAutoSettings(page)
  },
)

Then("GraphQL health is true", async () => {
  const data = await graphqlJson<{ health: boolean }>(`query { health }`)
  expect(data.health).toBe(true)
})

Then(
  "the default Agent Backend status is UNAVAILABLE for opencode",
  async () => {
    const data = await graphqlJson<{
      config: { selectedAgentBackend: string }
      agentBackendStatus: {
        kind: string
        reason: string | null
        backend: { id: string }
        selectedBackend: { id: string } | null
      }
    }>(`query {
      config { selectedAgentBackend }
      agentBackendStatus {
        kind
        reason
        backend { id }
        selectedBackend { id }
      }
    }`)

    expect(data.config.selectedAgentBackend).toBe("opencode")
    const status = data.agentBackendStatus
    const selectedId = status.selectedBackend?.id ?? status.backend.id
    expect(selectedId).toBe("opencode")
    expect(status.kind.toUpperCase()).toBe("UNAVAILABLE")
    // Reason must be present so operators are not left with a silent failure.
    expect((status.reason ?? "").trim().length).toBeGreaterThan(0)
  },
)

Then(
  "Claude Code preview status is {word}",
  // biome-ignore lint/correctness/noEmptyPattern: playwright-bdd requires the first argument to use the object destructuring pattern.
  async ({}, expectedKind: string) => {
    const data = await graphqlJson<{
      previewAgentBackend: {
        kind: string
        backend: { id: string }
      }
    }>(
      `query PreviewClaude($backendId: String!) {
        previewAgentBackend(backendId: $backendId) {
          kind
          backend { id }
        }
      }`,
      { backendId: "claude" },
    )
    expect(data.previewAgentBackend.backend.id).toBe("claude")
    expect(data.previewAgentBackend.kind.toUpperCase()).toBe(
      expectedKind.toUpperCase(),
    )
  },
)

/**
 * Page-shell default-Unavailable banner (tag Backend, role status).
 * Copy varies: pure absence uses "OpenCode: <reason>"; mixed-Ready uses
 * "Default Agent Backend 'opencode' is not available … Ready: …" (#937).
 */
const backendBanner = (page: Page) =>
  page
    .getByRole("status")
    .filter({ has: page.getByRole("button", { name: "Open Settings" }) })
    .filter({
      hasText: /OpenCode|opencode|Agent Backend|not available|unavailable/i,
    })

Then(
  "the UI shows default Agent Backend Unavailable guidance",
  async ({ page }) => {
    const banner = backendBanner(page)
    await expect(banner).toBeVisible({ timeout: 60_000 })
    await expect(banner).toContainText(
      /not available|unavailable|NotFound|OpenCode/i,
    )
    await expect(banner).toContainText(/opencode/i)
  },
)

Then(
  "the UI does not list Ready Agent Backend alternatives",
  async ({ page }) => {
    const banner = backendBanner(page)
    await expect(banner).toBeVisible({ timeout: 60_000 })
    // #937 mixed-Ready guidance includes "Ready: …"; pure absence must not.
    await expect(banner).not.toContainText(/Ready:\s*\S+/i)
  },
)

Then(
  "the UI lists Ready Agent Backend alternative {string}",
  async ({ page }, backendId: string) => {
    const banner = backendBanner(page)
    await expect(banner).toBeVisible({ timeout: 60_000 })
    // Banner probes non-default backends via previewAgentBackend; allow time.
    // Ready list may include several ids ("Ready: claude" or "Ready: grok, claude").
    await expect(banner).toContainText(
      new RegExp(`Ready:.*\\b${backendId}\\b`, "i"),
      { timeout: 60_000 },
    )
  },
)
