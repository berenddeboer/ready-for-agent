import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Window } from "happy-dom"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import {
  type ImplementWithSubmitInput,
  nextImplementWithCatalogPin,
  usablePreviewCatalog,
} from "../src/execution-profile-draft.js"
import {
  ImplementWithDialog,
  type ImplementWithDialogProps,
} from "../src/implement-with-dialog.js"
import { afterEach, describe, expect, test } from "bun:test"

const catalogModels = [
  { id: "sonnet", thinkingLevels: ["low", "high"], name: "Sonnet" },
  { id: "haiku", thinkingLevels: ["low"], name: "Haiku" },
] as const

const readyCatalog = {
  loading: false,
  failed: false,
  error: null,
  models: catalogModels,
  warnings: [],
}

const INSTALLED_GLOBAL_KEYS = [
  "window",
  "document",
  "Event",
  "HTMLElement",
  "HTMLDialogElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "DocumentFragment",
  "SVGElement",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const

const installDom = () => {
  const previous = new Map<string, { had: boolean; value: unknown }>()
  const g = globalThis as unknown as Record<string, unknown>
  for (const key of INSTALLED_GLOBAL_KEYS) {
    previous.set(key, { had: Object.hasOwn(g, key), value: g[key] })
  }
  const happyWindow = new Window({ url: "https://localhost/" })
  g.window = happyWindow
  g.document = happyWindow.document
  g.Event = happyWindow.Event
  g.HTMLElement = happyWindow.HTMLElement
  g.HTMLDialogElement = happyWindow.HTMLDialogElement
  g.HTMLSelectElement = happyWindow.HTMLSelectElement
  g.HTMLButtonElement = happyWindow.HTMLButtonElement
  g.HTMLFormElement = happyWindow.HTMLFormElement
  g.HTMLInputElement = happyWindow.HTMLInputElement
  g.Element = happyWindow.Element
  g.Node = happyWindow.Node
  g.DocumentFragment = happyWindow.DocumentFragment
  g.SVGElement = happyWindow.SVGElement
  g.navigator = happyWindow.navigator
  g.IS_REACT_ACT_ENVIRONMENT = true
  return {
    document: happyWindow.document as unknown as Document,
    fire: (target: EventTarget, type: string) => {
      target.dispatchEvent(
        new happyWindow.Event(type, {
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      )
    },
    restore: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      happyWindow.close()
      for (const key of INSTALLED_GLOBAL_KEYS) {
        const prior = previous.get(key)
        if (prior === undefined) continue
        if (prior.had) {
          g[key] = prior.value
        } else {
          delete g[key]
        }
      }
    },
  }
}

const shippedBackends = [
  { id: "opencode", label: "OpenCode" },
  { id: "grok", label: "Grok Build" },
  { id: "codex", label: "Codex Build" },
  { id: "claude", label: "Claude Code" },
] as const

const grokCatalog = {
  loading: false,
  failed: false,
  error: null,
  models: [
    { id: "grok-code", thinkingLevels: ["low", "high"], name: "Grok Code" },
  ],
  warnings: [],
}

const baseProps = {
  issueNumber: 1034,
  backendId: "opencode",
  backends: shippedBackends,
  configurationMode: null,
  initialDraft: {
    buildModel: "sonnet",
    buildThinkingLevel: "high",
    reviewSameAsBuild: true as const,
  },
  catalog: readyCatalog,
  initialAutoMerge: false,
  submitPending: false,
  submitError: null,
  onSubmit: () => undefined,
  onBackendChange: () => undefined,
  onCancel: () => undefined,
} satisfies ImplementWithDialogProps

describe("ImplementWithDialog copy and catalog", () => {
  test("titles the ephemeral command and explains Work Item-only choices", () => {
    const html = renderToStaticMarkup(<ImplementWithDialog {...baseProps} />)
    expect(html).toContain("Implement issue #1034 with...")
    expect(html).toContain("These choices apply only to this Work Item")
    expect(html).toContain("never change Repository settings or Harness Config")
    expect(html).toContain("OpenCode")
    expect(html).toContain("Grok Build")
    expect(html).toContain("Codex Build")
    expect(html).toContain("Claude Code")
    expect(html).toContain('name="agentBackend"')
    expect(html).not.toContain("Repository Effective Agent Backend")
    expect(html).toContain("does not change saved defaults")
    expect(html).toContain(">Implement<")
    expect(html).toContain(">Cancel<")
    expect(html).not.toContain("Recheck")
    expect(html).not.toContain('href="/settings"')
    expect(html).not.toContain("<datalist")
    expect(html).toContain('name="autoMerge"')
    expect(html).toContain('name="implementLocally"')
    expect(html).toContain("inspect the worktree")
  })

  test("initializes Auto-merge from the Repository setting and Implement locally to false", () => {
    const disabled = renderToStaticMarkup(
      <ImplementWithDialog {...baseProps} initialAutoMerge={false} />,
    )
    expect(disabled).toContain('name="autoMerge"')
    expect(disabled).not.toMatch(/name="autoMerge"[^>]*checked/)
    expect(disabled).not.toMatch(/name="implementLocally"[^>]*checked/)
    const enabled = renderToStaticMarkup(
      <ImplementWithDialog {...baseProps} initialAutoMerge={true} />,
    )
    expect(enabled).toMatch(/name="autoMerge"[^>]*checked/)
    expect(enabled).not.toMatch(/name="implementLocally"[^>]*checked/)
  })

  test("starts from pre-filled build values and Same as build", () => {
    const html = renderToStaticMarkup(<ImplementWithDialog {...baseProps} />)
    expect(html).toContain('name="buildModel"')
    expect(html).toContain('value="sonnet"')
    expect(html).toContain('name="buildThinkingLevel"')
    expect(html).toContain('value="high"')
    expect(html).toContain(">Same as build</option>")
    expect(html).toContain('name="reviewThinkingLevel"')
    expect(html).toContain("disabled")
  })

  test("keeps a pre-filled Thinking Level while the catalog is still loading", () => {
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        catalog={{
          loading: true,
          failed: false,
          error: null,
          models: undefined,
          warnings: [],
        }}
      />,
    )
    expect(html).toContain('name="buildThinkingLevel"')
    expect(html).toContain('value="high"')
  })

  test("shows a Harness preference load failure without hiding the form", () => {
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        prefsError="Could not load Harness model preferences for this Agent Backend."
      />,
    )
    expect(html).toContain("Could not load Harness model preferences")
    expect(html).toContain('role="alert"')
    expect(html).toContain(">Implement<")
  })

  test("a missing default build model is a blank required catalog choice", () => {
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        initialDraft={{
          buildModel: "",
          buildThinkingLevel: "",
          reviewSameAsBuild: true,
        }}
      />,
    )
    expect(html).toContain(">Select a build model</option>")
    expect(html).toContain("Select a model from the Agent Model catalog.")
  })

  test("a failed Preview keeps the backend selector usable and blocks Implement", () => {
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        catalog={{
          loading: false,
          failed: true,
          error: "Could not inspect Grok Build.",
          models: [],
          warnings: [],
        }}
      />,
    )
    expect(html).toContain("Could not inspect Grok Build.")
    expect(html).toContain('name="agentBackend"')
    expect(html).not.toMatch(/name="agentBackend"[^>]*disabled/)
    expect(html).toContain('name="buildModel"')
    expect(html).toMatch(/name="buildModel"[^>]*disabled/)
    expect(html).toContain(">Implement<")
    expect(html).toMatch(/type="submit"[^>]*disabled/)
    expect(html).not.toContain("Recheck")
    expect(html).not.toContain('href="/settings"')
  })

  test("a later different READY list keeps Implement enabled and membership banners down", () => {
    const firstReady = {
      kind: "READY",
      models: catalogModels,
    }
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: firstReady,
    })
    const usable = usablePreviewCatalog({
      preview: {
        kind: "READY",
        models: [{ id: "other-provider-id", thinkingLevels: [] }],
      },
      previewFailed: false,
      pin,
    })
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        catalog={{
          loading: false,
          failed: usable.failed,
          error: null,
          models: usable.models,
          warnings: [],
        }}
      />,
    )
    expect(html).not.toContain(
      "The selected model is not in the current Agent Model catalog",
    )
    expect(html).not.toContain(
      "Build effort (thinking) is unavailable — the selected model is",
    )
    expect(html).toContain('name="buildThinkingLevel"')
    expect(html).toContain('value="high"')
    expect(html).toContain(">Same as build</option>")
    expect(html).not.toMatch(/type="submit"[^>]*\sdisabled=/)
    expect(html).toMatch(/name="autoMerge"/)
    expect(html).toMatch(/name="implementLocally"/)
    expect(html).not.toMatch(/name="autoMerge"[^>]*checked/)
    expect(html).not.toMatch(/name="implementLocally"[^>]*checked/)
  })

  test("an explicit review model from the first READY catalog stays valid after a later list", () => {
    const firstReady = {
      kind: "READY",
      models: catalogModels,
    }
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: firstReady,
    })
    const usable = usablePreviewCatalog({
      preview: { kind: "UNAVAILABLE", models: [] },
      previewFailed: false,
      pin,
    })
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        initialDraft={{
          buildModel: "sonnet",
          buildThinkingLevel: "high",
          reviewSameAsBuild: false,
          reviewModel: "haiku",
          reviewThinkingLevel: "low",
        }}
        catalog={{
          loading: false,
          failed: usable.failed,
          error: null,
          models: usable.models,
          warnings: [],
        }}
      />,
    )
    expect(html).not.toContain(
      "The selected model is not in the current Agent Model catalog",
    )
    expect(html).not.toContain(
      "Review effort (thinking) is unavailable — the selected model is",
    )
    expect(html).toContain('name="reviewThinkingLevel"')
    expect(html).toContain('value="low"')
    expect(html).not.toMatch(/type="submit"[^>]*\sdisabled=/)
  })

  test("a model never in the first READY catalog stays unavailable after pinning", () => {
    const firstReady = {
      kind: "READY",
      models: catalogModels,
    }
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: firstReady,
    })
    const usable = usablePreviewCatalog({
      preview: {
        kind: "READY",
        models: [
          ...catalogModels,
          { id: "ghost", thinkingLevels: ["low"], name: "Ghost" },
        ],
      },
      previewFailed: false,
      pin,
    })
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        initialDraft={{
          buildModel: "ghost",
          buildThinkingLevel: "low",
          reviewSameAsBuild: true,
        }}
        catalog={{
          loading: false,
          failed: usable.failed,
          error: null,
          models: usable.models,
          warnings: [],
        }}
      />,
    )
    expect(html).toContain(
      "The selected model is not in the current Agent Model catalog. Choose a listed model.",
    )
    expect(html).toMatch(/type="submit"[^>]*disabled/)
  })

  test("a blank required build model stays blank when a catalog is pinned", () => {
    const firstReady = {
      kind: "READY",
      models: catalogModels,
    }
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: firstReady,
    })
    const usable = usablePreviewCatalog({
      preview: firstReady,
      previewFailed: false,
      pin,
    })
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        initialDraft={{
          buildModel: "",
          buildThinkingLevel: "",
          reviewSameAsBuild: true,
        }}
        catalog={{
          loading: false,
          failed: usable.failed,
          error: null,
          models: usable.models,
          warnings: [],
        }}
      />,
    )
    expect(html).toContain(">Select a build model</option>")
    expect(html).toContain("Select a model from the Agent Model catalog.")
    expect(html).toMatch(/type="submit"[^>]*disabled/)
  })

  test("an empty catalog cannot be submitted and explains why", () => {
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        catalog={{
          loading: false,
          failed: false,
          error: null,
          models: [],
          warnings: [],
        }}
      />,
    )
    expect(html).toContain(
      "Implement With requires a non-empty Agent Model catalog.",
    )
    expect(html).toMatch(/type="submit"[^>]*disabled/)
    expect(html).not.toContain("Recheck")
  })
})

describe("ImplementWithDialog interaction", () => {
  let restore: (() => Promise<void>) | undefined
  let container: HTMLElement | undefined
  let root: ReturnType<typeof createRoot> | undefined
  let fireEvent: ((target: EventTarget, type: string) => void) | undefined

  afterEach(async () => {
    if (root !== undefined) {
      flushSync(() => root?.unmount())
    }
    await restore?.()
    restore = undefined
    container = undefined
    root = undefined
    fireEvent = undefined
  })

  const render = (props: Partial<ImplementWithDialogProps> = {}) => {
    const installed = installDom()
    restore = installed.restore
    fireEvent = installed.fire
    container = installed.document.createElement("div")
    installed.document.body.appendChild(container)
    root = createRoot(container)
    const submitted: ImplementWithSubmitInput[] = []
    const backendChanges: string[] = []
    let cancelled = 0
    const rerender = (next: Partial<ImplementWithDialogProps> = {}) => {
      flushSync(() => {
        root?.render(
          <ImplementWithDialog
            {...baseProps}
            {...props}
            {...next}
            onSubmit={(input) => submitted.push(input)}
            onBackendChange={(backendId) => backendChanges.push(backendId)}
            onCancel={() => {
              cancelled += 1
            }}
          />,
        )
      })
    }
    rerender()
    return {
      node: container as HTMLElement,
      submitted,
      backendChanges,
      cancelled: () => cancelled,
      rerender,
    }
  }

  const fire = (target: EventTarget | null, type: string) => {
    if (target === null || fireEvent === undefined) {
      throw new Error("missing event target")
    }
    fireEvent(target, type)
  }

  const toggleCheckbox = (input: HTMLInputElement, checked: boolean) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "checked",
    )
    descriptor?.set?.call(input, checked)
    fire(input, "click")
    fire(input, "input")
    fire(input, "change")
  }

  const selectNamed = (node: HTMLElement, name: string): HTMLSelectElement => {
    const select = node.querySelector(`select[name="${name}"]`)
    if (select === null) {
      throw new Error(`missing select ${name}`)
    }
    return select as HTMLSelectElement
  }

  test("submitting unchanged pre-filled values still creates an explicit profile", () => {
    const { node, submitted } = render()
    const form = node.querySelector("form")
    flushSync(() => {
      fire(form, "submit")
    })
    expect(submitted).toEqual([
      {
        profile: {
          agentBackendId: "opencode",
          buildModel: "sonnet",
          buildThinkingLevel: "high",
          reviewSameAsBuild: true,
          reviewModel: null,
          reviewThinkingLevel: null,
        },
        options: { autoMerge: false, implementLocally: false },
      },
    ])
  })

  test("an explicit review model unlocks its own Thinking Level", () => {
    const { node, submitted } = render()
    const review = selectNamed(node, "reviewModel")
    flushSync(() => {
      review.value = "haiku"
      fire(review, "change")
    })
    const reviewThinking = selectNamed(node, "reviewThinkingLevel")
    expect(reviewThinking.disabled).toBe(false)
    flushSync(() => {
      reviewThinking.value = "low"
      fire(reviewThinking, "change")
    })
    flushSync(() => {
      fire(node.querySelector("form"), "submit")
    })
    expect(submitted.at(-1)).toEqual({
      profile: {
        agentBackendId: "opencode",
        buildModel: "sonnet",
        buildThinkingLevel: "high",
        reviewSameAsBuild: false,
        reviewModel: "haiku",
        reviewThinkingLevel: "low",
      },
      options: { autoMerge: false, implementLocally: false },
    })
  })

  test("changing the build model drops an incompatible Thinking Level", () => {
    const { node, submitted } = render()
    const build = selectNamed(node, "buildModel")
    flushSync(() => {
      build.value = "haiku"
      fire(build, "change")
    })
    flushSync(() => {
      fire(node.querySelector("form"), "submit")
    })
    expect(submitted.at(-1)?.profile.buildModel).toBe("haiku")
    expect(submitted.at(-1)?.profile.buildThinkingLevel).toBeNull()
  })

  test("pending submission disables Implement, Cancel, and the option checkboxes", () => {
    const { node } = render({ submitPending: true })
    const implement = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Starting...",
    )
    const cancel = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )
    const autoMerge = node.querySelector(
      'input[name="autoMerge"]',
    ) as HTMLInputElement | null
    const implementLocally = node.querySelector(
      'input[name="implementLocally"]',
    ) as HTMLInputElement | null
    expect(implement?.disabled).toBe(true)
    expect(cancel?.disabled).toBe(true)
    expect(autoMerge?.disabled).toBe(true)
    expect(implementLocally?.disabled).toBe(true)
  })

  test("a failed submission keeps the dialog open with the actionable error", () => {
    const html = renderToStaticMarkup(
      <ImplementWithDialog
        {...baseProps}
        submitError="Issue #1034 is no longer Actionable"
      />,
    )
    expect(html).toContain("Implement issue #1034 with...")
    expect(html).toContain("Issue #1034 is no longer Actionable")
    expect(html).toContain('role="alert"')
  })

  test("Cancel discards the command", () => {
    const { node, cancelled } = render()
    const cancel = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )
    flushSync(() => {
      fire(cancel ?? null, "click")
    })
    expect(cancelled()).toBe(1)
  })

  test("switching backends loads that backend's prefill without discarding the other draft", () => {
    const { node, submitted, backendChanges, rerender } = render()
    const backend = selectNamed(node, "agentBackend")
    const build = selectNamed(node, "buildModel")
    flushSync(() => {
      build.value = "haiku"
      fire(build, "change")
    })
    flushSync(() => {
      backend.value = "grok"
      fire(backend, "change")
    })
    expect(backendChanges).toEqual(["grok"])
    rerender({
      backendId: "grok",
      catalog: grokCatalog,
      initialDraft: {
        buildModel: "grok-code",
        buildThinkingLevel: "low",
        reviewSameAsBuild: true,
      },
    })
    expect(selectNamed(node, "buildModel").value).toBe("grok-code")
    expect(selectNamed(node, "buildThinkingLevel").value).toBe("low")
    flushSync(() => {
      selectNamed(node, "buildThinkingLevel").value = "high"
      fire(selectNamed(node, "buildThinkingLevel"), "change")
    })
    flushSync(() => {
      selectNamed(node, "agentBackend").value = "opencode"
      fire(selectNamed(node, "agentBackend"), "change")
    })
    rerender({
      backendId: "opencode",
      catalog: readyCatalog,
      initialDraft: {
        buildModel: "sonnet",
        buildThinkingLevel: "high",
        reviewSameAsBuild: true,
      },
    })
    expect(selectNamed(node, "buildModel").value).toBe("haiku")
    flushSync(() => {
      fire(node.querySelector("form"), "submit")
    })
    expect(submitted.at(-1)).toEqual({
      profile: {
        agentBackendId: "opencode",
        buildModel: "haiku",
        buildThinkingLevel: null,
        reviewSameAsBuild: true,
        reviewModel: null,
        reviewThinkingLevel: null,
      },
      options: { autoMerge: false, implementLocally: false },
    })
    rerender({
      backendId: "grok",
      catalog: grokCatalog,
      initialDraft: {
        buildModel: "grok-code",
        buildThinkingLevel: "low",
        reviewSameAsBuild: true,
      },
    })
    flushSync(() => {
      fire(node.querySelector("form"), "submit")
    })
    expect(submitted.at(-1)).toEqual({
      profile: {
        agentBackendId: "grok",
        buildModel: "grok-code",
        buildThinkingLevel: "high",
        reviewSameAsBuild: true,
        reviewModel: null,
        reviewThinkingLevel: null,
      },
      options: { autoMerge: false, implementLocally: false },
    })
  })

  test("toggling options does not change model drafts and survives backend switching", () => {
    const { node, submitted, rerender } = render({ initialAutoMerge: true })
    const autoMerge = node.querySelector(
      'input[name="autoMerge"]',
    ) as HTMLInputElement
    const implementLocally = node.querySelector(
      'input[name="implementLocally"]',
    ) as HTMLInputElement
    expect(autoMerge.checked).toBe(true)
    expect(implementLocally.checked).toBe(false)
    flushSync(() => {
      toggleCheckbox(autoMerge, false)
      toggleCheckbox(implementLocally, true)
    })
    expect(autoMerge.checked).toBe(false)
    expect(implementLocally.checked).toBe(true)
    rerender({
      backendId: "grok",
      catalog: grokCatalog,
      initialDraft: {
        buildModel: "grok-code",
        buildThinkingLevel: "low",
        reviewSameAsBuild: true,
      },
      initialAutoMerge: true,
    })
    expect(
      (node.querySelector('input[name="autoMerge"]') as HTMLInputElement)
        .checked,
    ).toBe(false)
    expect(
      (node.querySelector('input[name="implementLocally"]') as HTMLInputElement)
        .checked,
    ).toBe(true)
    flushSync(() => {
      fire(node.querySelector("form"), "submit")
    })
    expect(submitted.at(-1)?.options).toEqual({
      autoMerge: false,
      implementLocally: true,
    })
    rerender({
      catalog: {
        loading: true,
        failed: false,
        error: null,
        models: undefined,
        warnings: [],
      },
    })
    expect(
      (node.querySelector('input[name="autoMerge"]') as HTMLInputElement)
        .checked,
    ).toBe(false)
    expect(
      (node.querySelector('input[name="implementLocally"]') as HTMLInputElement)
        .checked,
    ).toBe(true)
  })

  test("reopening restores Auto-merge from the current Repository value", () => {
    const first = renderToStaticMarkup(
      <ImplementWithDialog {...baseProps} initialAutoMerge={true} />,
    )
    expect(first).toMatch(/name="autoMerge"[^>]*checked/)
    const second = renderToStaticMarkup(
      <ImplementWithDialog {...baseProps} initialAutoMerge={false} />,
    )
    expect(second).not.toMatch(/name="autoMerge"[^>]*checked/)
    expect(second).not.toMatch(/name="implementLocally"[^>]*checked/)
  })

  test("catalog pinning does not reset Auto-merge or Implement locally", () => {
    const firstReady = {
      kind: "READY",
      models: catalogModels,
    }
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: firstReady,
    })
    const replaced = usablePreviewCatalog({
      preview: {
        kind: "READY",
        models: [{ id: "other-provider-id", thinkingLevels: [] }],
      },
      previewFailed: false,
      pin,
    })
    const { node, rerender } = render({ initialAutoMerge: true })
    const implementLocally = node.querySelector(
      'input[name="implementLocally"]',
    ) as HTMLInputElement
    flushSync(() => {
      toggleCheckbox(implementLocally, true)
    })
    rerender({
      catalog: {
        loading: false,
        failed: replaced.failed,
        error: null,
        models: replaced.models,
        warnings: [],
      },
    })
    expect(
      (node.querySelector('input[name="autoMerge"]') as HTMLInputElement)
        .checked,
    ).toBe(true)
    expect(
      (node.querySelector('input[name="implementLocally"]') as HTMLInputElement)
        .checked,
    ).toBe(true)
    const implement = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Implement",
    )
    expect(implement?.disabled).toBe(false)
    expect(node.textContent).not.toContain(
      "The selected model is not in the current Agent Model catalog",
    )
  })

  test("a failed backend does not disable switching to another shipped backend", () => {
    const { node, backendChanges } = render({
      catalog: {
        loading: false,
        failed: true,
        error: "Could not inspect OpenCode.",
        models: [],
        warnings: [],
      },
    })
    const backend = selectNamed(node, "agentBackend")
    expect(backend.disabled).toBe(false)
    flushSync(() => {
      backend.value = "claude"
      fire(backend, "change")
    })
    expect(backendChanges).toEqual(["claude"])
  })
})

describe("Implement With preview query contract", () => {
  test("does not refetch the preview on focus, reconnect, or an interval", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/implement-with-issue-dialog.tsx"),
      "utf8",
    )
    const previewStart = source.indexOf(
      'queryKey: ["implement-with", "preview"',
    )
    expect(previewStart).toBeGreaterThan(-1)
    const preview = source.slice(
      previewStart,
      source.indexOf("return result.previewAgentBackend", previewStart),
    )
    expect(preview).toContain("refetchOnWindowFocus: false")
    expect(preview).toContain("refetchOnReconnect: false")
    expect(preview).toContain("refetchInterval: false")
    expect(preview).toContain("gcTime: 0")
    expect(source).toContain("implementWithSessionPreview")
    expect(source).toContain("isFetchedAfterMount")
  })
})
