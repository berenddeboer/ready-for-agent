import { Window } from "happy-dom"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import type { ImplementWithProfileInput } from "../src/execution-profile-draft.js"
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

const baseProps = {
  issueNumber: 1034,
  backendId: "opencode",
  backendLabel: "OpenCode",
  configurationMode: null,
  initialDraft: {
    buildModel: "sonnet",
    buildThinkingLevel: "high",
    reviewSameAsBuild: true as const,
  },
  catalog: readyCatalog,
  submitPending: false,
  submitError: null,
  onSubmit: () => undefined,
  onCancel: () => undefined,
} satisfies ImplementWithDialogProps

describe("ImplementWithDialog copy and catalog", () => {
  test("titles the ephemeral command and explains Work Item-only choices", () => {
    const html = renderToStaticMarkup(<ImplementWithDialog {...baseProps} />)
    expect(html).toContain("Implement issue #1034 with...")
    expect(html).toContain("These choices apply only to this Work Item")
    expect(html).toContain("never change Repository settings or Harness Config")
    expect(html).toContain("OpenCode")
    expect(html).toContain("Repository Effective Agent Backend")
    expect(html).toContain(">Implement<")
    expect(html).toContain(">Cancel<")
    expect(html).not.toContain("Recheck")
    expect(html).not.toContain('href="/settings"')
    expect(html).not.toContain("<input")
    expect(html).not.toContain("<datalist")
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
    const submitted: ImplementWithProfileInput[] = []
    let cancelled = 0
    flushSync(() => {
      root?.render(
        <ImplementWithDialog
          {...baseProps}
          {...props}
          onSubmit={(profile) => submitted.push(profile)}
          onCancel={() => {
            cancelled += 1
          }}
        />,
      )
    })
    return { node: container, submitted, cancelled: () => cancelled }
  }

  const fire = (target: EventTarget | null, type: string) => {
    if (target === null || fireEvent === undefined) {
      throw new Error("missing event target")
    }
    fireEvent(target, type)
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
        agentBackendId: "opencode",
        buildModel: "sonnet",
        buildThinkingLevel: "high",
        reviewSameAsBuild: true,
        reviewModel: null,
        reviewThinkingLevel: null,
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
      agentBackendId: "opencode",
      buildModel: "sonnet",
      buildThinkingLevel: "high",
      reviewSameAsBuild: false,
      reviewModel: "haiku",
      reviewThinkingLevel: "low",
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
    expect(submitted.at(-1)?.buildModel).toBe("haiku")
    expect(submitted.at(-1)?.buildThinkingLevel).toBeNull()
  })

  test("pending submission disables Implement and Cancel", () => {
    const { node } = render({ submitPending: true })
    const implement = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Starting...",
    )
    const cancel = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )
    expect(implement?.disabled).toBe(true)
    expect(cancel?.disabled).toBe(true)
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
})
