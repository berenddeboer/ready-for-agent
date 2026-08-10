import {
  formatBuildModelNotConfiguredMessage,
  formatDefaultBackendUnavailableMessage,
} from "../src/lib/operator-guidance.js"
import { describe, expect, it } from "bun:test"

describe("formatDefaultBackendUnavailableMessage", () => {
  it("returns null when no other backend is Ready", () => {
    expect(
      formatDefaultBackendUnavailableMessage({
        defaultBackendId: "opencode",
        reason: "not installed",
        readyBackendIds: [],
      }),
    ).toBeNull()
  })

  it("names the default backend, reason, and Ready backends", () => {
    expect(
      formatDefaultBackendUnavailableMessage({
        defaultBackendId: "opencode",
        reason: "not installed",
        readyBackendIds: ["claude"],
      }),
    ).toBe(
      "Default Agent Backend 'opencode' is not available (not installed). Ready: claude.",
    )
  })

  it("lists multiple Ready backends and falls back when reason is blank", () => {
    expect(
      formatDefaultBackendUnavailableMessage({
        defaultBackendId: "opencode",
        reason: "  ",
        readyBackendIds: ["claude", "codex"],
      }),
    ).toBe(
      "Default Agent Backend 'opencode' is not available (unavailable). Ready: claude, codex.",
    )
  })
})

describe("formatBuildModelNotConfiguredMessage", () => {
  it("names harness-default scope without a catalog", () => {
    expect(
      formatBuildModelNotConfiguredMessage({
        backendId: "opencode",
      }),
    ).toBe(
      "No build model set for Agent Backend 'OpenCode' (harness default). Set one in Settings, or per repository.",
    )
  })

  it("names repository scope, backend label, and available models", () => {
    expect(
      formatBuildModelNotConfiguredMessage({
        backendId: "claude",
        repositoryProjectPath: "acme/widgets",
        availableModelIds: ["haiku", "sonnet", "opus", "fable"],
      }),
    ).toBe(
      "No build model set for acme/widgets on Agent Backend 'Claude Code'. Available: haiku, sonnet, opus, fable. Set one in Settings, or per repository.",
    )
  })

  it("caps long available lists", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `model-${i}`)
    const message = formatBuildModelNotConfiguredMessage({
      backendId: "grok",
      availableModelIds: ids,
    })
    expect(message).toContain("Available: model-0, model-1, model-2, model-3")
    expect(message).toContain("(+2 more)")
    expect(message).toContain("Agent Backend 'Grok Build'")
    expect(message).toContain("Set one in Settings, or per repository.")
  })
})
