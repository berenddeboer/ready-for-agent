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
    // Provider comes from inspect/status — not CLAUDE_CODE_USE_BEDROCK alone.
    expect(source).not.toContain("CLAUDE_CODE_USE_BEDROCK")
  })
})
