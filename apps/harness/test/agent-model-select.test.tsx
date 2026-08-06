import { renderToStaticMarkup } from "react-dom/server"
import {
  AGENT_MODEL_CATALOG_LOADING_LABEL,
  AgentModelSelect,
  UNAVAILABLE_AGENT_MODEL_SUFFIX,
} from "../src/agent-model-select.js"
import type { AgentModelOption } from "../src/agent-model-settings.js"
import { describe, expect, test } from "bun:test"

/**
 * Issue #838: every Agent Model control in Settings is a real `<select>` over
 * the current catalog. Assertions are on rendered markup an operator can act
 * on — the control type, the choices offered, and the guidance shown — not on
 * component internals.
 */

const claudeCatalog: readonly AgentModelOption[] = [
  { id: "haiku", thinkingLevels: ["low", "high"] },
  { id: "sonnet", thinkingLevels: ["low", "high"] },
  { id: "opus", thinkingLevels: ["low", "high"] },
  { id: "fable", thinkingLevels: ["low", "high"] },
]

const STALE_BEDROCK_PROFILE = "us.anthropic.claude-sonnet-4-6"

const render = (overrides: Partial<Parameters<typeof AgentModelSelect>[0]>) =>
  renderToStaticMarkup(
    <AgentModelSelect
      label="Build model"
      name="defaultModel"
      value=""
      onChange={() => {}}
      models={claudeCatalog}
      catalogLoading={false}
      allowClear={false}
      required
      disabled={false}
      placeholder="Select a build model"
      emptyCatalogLabel="No Agent Models available"
      blockReason={null}
      hint="Used for implement and other build steps."
      {...overrides}
    />,
  )

describe("Agent Model control is catalog-only (issue #838)", () => {
  test("renders a select over the catalog — never a text input or datalist", () => {
    const html = render({})
    expect(html).toContain('<select class="')
    expect(html).toContain('name="defaultModel"')
    expect(html).not.toContain("<input")
    expect(html).not.toContain("<datalist")
    expect(html).not.toContain("list=")
    for (const model of claudeCatalog) {
      expect(html).toContain(`<option value="${model.id}">${model.id}</option>`)
    }
  })

  test("offers every catalog entry with its operator-facing label", () => {
    const html = render({
      models: [
        {
          id: STALE_BEDROCK_PROFILE,
          thinkingLevels: ["low"],
          name: "US Anthropic Claude Sonnet 4.6",
          kind: "SYSTEM_DEFINED",
        },
      ],
    })
    expect(html).toContain(
      `US Anthropic Claude Sonnet 4.6 · System · ${STALE_BEDROCK_PROFILE}`,
    )
    // The persisted value stays the executable id, not the friendly name.
    expect(html).toContain(`<option value="${STALE_BEDROCK_PROFILE}">`)
  })

  test("preserves a stored non-catalog value as a visibly unavailable option", () => {
    const html = render({ value: STALE_BEDROCK_PROFILE })
    expect(html).toContain(
      `${STALE_BEDROCK_PROFILE} ${UNAVAILABLE_AGENT_MODEL_SUFFIX}</option>`,
    )
    // The current catalog is shown alongside it, so a fix is one click away.
    for (const model of claudeCatalog) {
      expect(html).toContain(`<option value="${model.id}">`)
    }
  })

  test("does not claim 'not in catalog' before a catalog loaded", () => {
    const html = render({
      value: STALE_BEDROCK_PROFILE,
      models: undefined,
      catalogLoading: true,
    })
    expect(html).toContain(`>${STALE_BEDROCK_PROFILE}</option>`)
    expect(html).not.toContain("not in Agent Model catalog")
    // With no value yet, the loading state is the visible placeholder.
    expect(
      render({ value: "", models: undefined, catalogLoading: true }),
    ).toContain(AGENT_MODEL_CATALOG_LOADING_LABEL)
  })

  test("shows the empty-catalog placeholder once the catalog loaded empty", () => {
    const html = render({ models: [], catalogLoading: false })
    expect(html).toContain("No Agent Models available")
    expect(html).not.toContain("Select a build model")
  })

  test("announces the Save block reason instead of the steady-state hint", () => {
    const blocked = render({
      value: STALE_BEDROCK_PROFILE,
      blockReason:
        "The selected model is not in the current Agent Model catalog. Choose a listed model before saving.",
    })
    expect(blocked).toContain('role="status"')
    expect(blocked).toContain("not in the current Agent Model catalog")
    expect(blocked).not.toContain("Used for implement and other build steps.")

    const healthy = render({ value: "sonnet" })
    expect(healthy).toContain("Used for implement and other build steps.")
    expect(healthy).not.toContain('role="status"')
  })

  test("a required field drops the empty option once a model is chosen", () => {
    expect(render({ value: "sonnet" })).not.toContain('<option value=""')
    expect(render({ value: "" })).toContain('<option value=""')
  })

  test("an optional field keeps the clear-to-inherit option", () => {
    const html = render({
      label: "Review model",
      name: "reviewModel",
      value: "sonnet",
      allowClear: true,
      required: false,
      placeholder: "Same as build model",
    })
    expect(html).toContain(">Same as build model</option>")
    expect(html).toContain('<option value=""')
  })
})
