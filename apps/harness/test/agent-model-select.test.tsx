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

/**
 * BER-23: catalog options are presented in a fixed alphabetical order. The
 * expected sequence below is a handwritten spec, not a call to the sorter.
 */
const optionValues = (html: string): readonly string[] =>
  [...html.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(
    (match) => match[1] ?? "",
  )

const shuffledCatalog: readonly AgentModelOption[] = [
  {
    id: "xai/grok-4",
    thinkingLevels: ["low"],
    name: "Alpha Grok",
  },
  {
    id: "opencode/gpt-5",
    thinkingLevels: ["high"],
    name: "ZZZ late name",
  },
  {
    id: "fireworks-ai/llama",
    thinkingLevels: ["max"],
    name: "AAA early name",
  },
  { id: "amazon-bedrock/claude-sonnet", thinkingLevels: ["max"] },
  {
    id: "opencode/claude",
    thinkingLevels: ["low"],
    name: "Should not lead",
  },
  {
    id: "zai-coding-plan/glm-4.6",
    thinkingLevels: [],
    name: "AAA",
    kind: "SYSTEM_DEFINED",
  },
  {
    id: "OpenCode/gpt",
    thinkingLevels: ["low"],
    name: "Case tie upper",
  },
  {
    id: "opencode/gpt",
    thinkingLevels: ["high"],
    name: "Case tie lower",
  },
  { id: "amazon-bedrock/claude-haiku", thinkingLevels: ["low"] },
  { id: "opencode/gpt-10", thinkingLevels: ["low"] },
]

const alphabeticalModelIds = [
  "amazon-bedrock/claude-haiku",
  "amazon-bedrock/claude-sonnet",
  "fireworks-ai/llama",
  "opencode/claude",
  "OpenCode/gpt",
  "opencode/gpt",
  "opencode/gpt-10",
  "opencode/gpt-5",
  "xai/grok-4",
  "zai-coding-plan/glm-4.6",
] as const

describe("Agent Model options are alphabetical by provider/model ID (BER-23)", () => {
  test("orders a shuffled multi-provider catalog by executable id, not name or discovery order", () => {
    const catalog = shuffledCatalog.map((model) => ({
      ...model,
      thinkingLevels: [...model.thinkingLevels],
    }))
    const before = catalog.map((model) => ({
      id: model.id,
      thinkingLevels: [...model.thinkingLevels],
      name: model.name,
      kind: model.kind,
    }))
    const html = render({
      models: catalog,
      value: "xai/grok-4",
      allowClear: false,
    })

    expect(optionValues(html)).toEqual([...alphabeticalModelIds])
    expect(html).toContain('value="xai/grok-4" selected=""')
    expect(html).not.toContain(
      'value="amazon-bedrock/claude-haiku" selected=""',
    )
    // Names stay visible, including a kind label that would sort first if the
    // display text were the key.
    expect(html).toContain("fireworks-ai/llama (AAA early name)")
    expect(html).toContain("AAA · System · zai-coding-plan/glm-4.6")
    expect(catalog).toEqual(before)
  })

  test("keeps inherit, Same as build, and unavailable saved selections above the sorted models", () => {
    const catalog = [...shuffledCatalog]
    const inherit = render({
      models: catalog,
      value: "",
      allowClear: true,
      required: false,
      placeholder: "Harness default (xai/grok-4)",
    })
    expect(optionValues(inherit)[0]).toBe("")
    expect(inherit).toContain(">Harness default (xai/grok-4)</option>")
    expect(optionValues(inherit).slice(1)).toEqual([...alphabeticalModelIds])

    const sameAsBuild = render({
      label: "Review model",
      name: "reviewModel",
      models: catalog,
      value: "opencode/gpt-5",
      allowClear: true,
      required: false,
      placeholder: "Same as build model",
    })
    expect(optionValues(sameAsBuild).slice(0, 1)).toEqual([""])
    expect(sameAsBuild).toContain(">Same as build model</option>")
    expect(sameAsBuild).toContain('value="opencode/gpt-5" selected=""')
    expect(optionValues(sameAsBuild).slice(1)).toEqual([
      ...alphabeticalModelIds,
    ])

    const unavailable = render({
      models: catalog,
      value: "missing/stale-model",
      allowClear: true,
      required: false,
      placeholder: "Harness default (opencode/big-pickle)",
    })
    expect(optionValues(unavailable).slice(0, 2)).toEqual([
      "",
      "missing/stale-model",
    ])
    expect(unavailable).toContain(
      `missing/stale-model ${UNAVAILABLE_AGENT_MODEL_SUFFIX}`,
    )
    expect(optionValues(unavailable).slice(2)).toEqual([
      ...alphabeticalModelIds,
    ])
    expect(catalog.map((model) => model.id)).toEqual(
      shuffledCatalog.map((model) => model.id),
    )
  })
})
