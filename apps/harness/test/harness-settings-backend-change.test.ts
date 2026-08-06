import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

describe("Harness settings Agent Backend change", () => {
  test("previews catalog and restores per-backend prefs without restart ceremony", () => {
    const source = rootSource()
    expect(source).toContain(
      "const applyAgentBackendSelection = async (nextBackend: string) => {",
    )
    expect(source).toContain(
      "void applyAgentBackendSelection(event.target.value)",
    )
    expect(source).toContain("previewAgentBackend")
    expect(source).toContain("harnessModelPrefs")
    expect(source).toContain("blockingUnfinishedWorkItemCount")
    expect(source).toContain("backendChangeBlocked")
    expect(source).toContain("Activates immediately on Save")
    expect(source).not.toContain("Cleared — choose after restart")
    expect(source).not.toContain("Takes effect after restart")
    expect(source).not.toContain("RESTART_REQUIRED")
    expect(source).toContain('defaultModel: defaultModel.trim() === ""')
  })

  test("global settings use multi-backend status and recheck by backend id", () => {
    const source = rootSource()
    expect(source).toContain("agentBackendStatuses")
    expect(source).toContain("recheckAgentBackend")
    expect(source).toContain("__args: { backendId }")
    expect(source).toContain("Recheck all")
    expect(source).toContain("Active Agent Backends")
    expect(source).toContain("Repositories inheriting the harness default")
    expect(source).toContain("Default Agent Backend")
    // First-run guidance covers default backend/model setup and per-repo overrides.
    expect(source).toContain(
      "Select a default agent backend, and default build model",
    )
    expect(source).toContain(
      "Optionally select a different review model (recommended)",
    )
    expect(source).toContain("override this per configured repo")
  })

  test("Active and preview status request provider and format Ready wording", () => {
    // Issue #819: Settings must surface Claude provider identity from GraphQL.
    const source = rootSource()
    expect(source).toContain("provider: { id: true, label: true }")
    expect(source).toContain("formatAgentBackendStatusTrail")
    expect(source).toContain("previewProvider")
    // Preview readiness must not mix stale Active Unavailable with a fresh preview.
    expect(source).toContain("kindForRow")
    expect(source).toContain("previewingThisRow && !previewPending")
    // Browser code must not read process environment for Bedrock mode (#828).
    expect(source).not.toContain("CLAUDE_CODE_USE_BEDROCK")
    expect(source).not.toContain("process.env")
  })

  test("requests and surfaces Bedrock discovery warnings with strict Bedrock select (issue #828)", () => {
    // Issue #820 warnings remain; #828 replaces free-text fallback in Bedrock mode.
    const source = rootSource()
    expect(source).toContain("warnings: true")
    expect(source).toContain("previewWarnings")
    expect(source).toContain("warningsForRow")
    expect(source).toContain('role="status"')
    // First-party free-text path still exists; Bedrock uses configurationMode.
    expect(source).toContain("allowsClaudeFreeTextModels")
    expect(source).toContain("claudeFreeTextModels")
    expect(source).toContain("configurationMode: true")
    expect(source).toContain("claudeBedrockStrict")
    expect(source).toContain("blocksClaudeBedrockModelSave")
    expect(source).toContain("bedrockBuildModelBlockReason")
    // Models from status/preview catalogs remain selectable (profile IDs/ARNs).
    expect(source).toContain(
      "models: { id: true, thinkingLevels: true, name: true, kind: true }",
    )
  })

  test("presents friendly Bedrock profile names and kinds while persisting executable ids (issue #821)", () => {
    const source = rootSource()
    expect(source).toContain("formatAgentModelLabel")
    expect(source).toContain("findCatalogModel")
    expect(source).toContain("isCustomAgentModelValue")
    expect(source).toContain("Catalog:")
    expect(source).toContain(
      "Custom value (not in Agent Model catalog) — stored",
    )
    // option value remains the executable id; label is friendly presentation.
    expect(source).toContain("value={model.id}")
    expect(source).toContain("{formatAgentModelLabel(model)}")
  })

  test("Claude Code Bedrock mode uses a strict select and blocks Save without a catalog profile", () => {
    // Issue #828 operator-visible Settings contract for Harness Config.
    const source = rootSource()
    expect(source).toContain("Select a Bedrock inference profile")
    expect(source).toContain("No Bedrock profiles available")
    expect(source).toContain("blockSaveForBedrockBuildModel")
    expect(source).toContain("not in Agent Model catalog")
    // Free-text datalist remains for first-party only (gated by claudeFreeTextModels).
    expect(source).toContain("harness-claude-build-models")
    // Disabled button and form onSubmit share one gate (Enter cannot bypass).
    expect(source).toContain("harnessSettingsSaveBlocked")
    expect(source).toContain("if (harnessSettingsSaveBlocked)")
    expect(source).toContain("disabled={harnessSettingsSaveBlocked}")
    // Fail closed while Claude configurationMode is unknown; Recheck with a
    // null cache invalidates the full status query instead of seeding empty
    // backends (which would re-enable free-text under Bedrock env).
    expect(source).toContain("claudeConfigurationModeUnresolved")
    expect(source).toContain("if (current == null)")
    expect(source).toContain("queryKey: agentBackendStatusQuery.queryKey")
    expect(source).toContain(
      "Preserve agentBackends (configurationMode) from the prior fetch",
    )
  })
})
