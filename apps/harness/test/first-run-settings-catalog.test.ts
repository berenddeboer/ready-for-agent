import {
  preferredFirstRunBackendIds,
  resolveDefaultBuildModelFromCatalog,
} from "../e2e/support/first-run-settings.ts"
import { describe, expect, test } from "bun:test"

describe("resolveDefaultBuildModelFromCatalog", () => {
  test("keeps a current model that is still in the catalog", () => {
    expect(
      resolveDefaultBuildModelFromCatalog({
        current: "sonnet",
        models: [{ id: "haiku" }, { id: "sonnet" }],
      }),
    ).toEqual({ kind: "already-configured" })
  })

  test("picks the first catalog model when the current value is missing", () => {
    expect(
      resolveDefaultBuildModelFromCatalog({
        current: null,
        models: [{ id: "" }, { id: "haiku" }],
      }),
    ).toEqual({ kind: "configure", modelId: "haiku" })
  })

  test("picks a catalog model when the current value is leftover and unusable", () => {
    expect(
      resolveDefaultBuildModelFromCatalog({
        current: "global.anthropic.claude-opus-5",
        models: [{ id: "sonnet" }],
      }),
    ).toEqual({ kind: "configure", modelId: "sonnet" })
  })

  test("reports an empty catalog so a later scenario can restore fake Claude", () => {
    expect(
      resolveDefaultBuildModelFromCatalog({
        current: "sonnet",
        models: [],
      }),
    ).toEqual({ kind: "empty-catalog" })
    expect(
      resolveDefaultBuildModelFromCatalog({
        current: null,
        models: [{ id: "" }],
      }),
    ).toEqual({ kind: "empty-catalog" })
  })
})

describe("preferredFirstRunBackendIds", () => {
  test("tries OpenCode first when it is listed, then the remaining backends", () => {
    expect(preferredFirstRunBackendIds(["claude", "opencode", "grok"])).toEqual(
      ["opencode", "claude", "grok"],
    )
  })

  test("keeps listed order when OpenCode is absent", () => {
    expect(preferredFirstRunBackendIds(["claude", "grok"])).toEqual([
      "claude",
      "grok",
    ])
  })

  test("drops empty option values", () => {
    expect(preferredFirstRunBackendIds(["", "opencode", ""])).toEqual([
      "opencode",
    ])
  })
})
