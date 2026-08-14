import { Window } from "happy-dom"
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { IssueActionsMenu } from "../src/issue-actions-menu.js"
import { afterEach, describe, expect, test } from "bun:test"

const INSTALLED_GLOBAL_KEYS = [
  "window",
  "document",
  "Event",
  "HTMLElement",
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

const defaultProps = {
  issueNumber: 1034,
  issueId: "issue-1034",
  implementPending: false,
  implementNowPending: false,
  implementLocallyPending: false,
  queuePending: false,
  onImplementNow: () => undefined,
  onImplementWith: () => undefined,
  onImplementLocally: () => undefined,
  onQueue: () => undefined,
}

describe("IssueActionsMenu", () => {
  test("actionable Issues offer Implement now, Implement with..., Implement locally in that order", () => {
    const html = renderToStaticMarkup(
      <IssueActionsMenu {...defaultProps} canImplement canQueue={false} />,
    )
    expect(html).toContain('aria-label="Actions for issue #1034"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).not.toContain("Implement now")
    expect(html).not.toContain("Queue")
  })

  test("blocked Issues show Queue only", () => {
    const html = renderToStaticMarkup(
      <IssueActionsMenu {...defaultProps} canImplement={false} canQueue />,
    )
    expect(html).toContain('aria-label="Actions for issue #1034"')
    expect(html).not.toContain("Implement now")
    expect(html).not.toContain("Implement with...")
    expect(html).not.toContain("Implement locally")
    expect(html).not.toContain("Queue")
  })

  test("hides the kebab when the Issue is not actionable and cannot be queued", () => {
    const html = renderToStaticMarkup(
      <IssueActionsMenu
        {...defaultProps}
        canImplement={false}
        canQueue={false}
      />,
    )
    expect(html).toBe("")
  })
})

describe("IssueActionsMenu interaction", () => {
  let restore: (() => Promise<void>) | undefined
  let container: HTMLElement | undefined
  let root: ReturnType<typeof createRoot> | undefined
  let fireEvent: ((target: EventTarget, type: string) => void) | undefined

  afterEach(async () => {
    if (root !== undefined && container !== undefined) {
      flushSync(() => root?.unmount())
    }
    await restore?.()
    restore = undefined
    container = undefined
    root = undefined
    fireEvent = undefined
  })

  const render = (tree: ReactNode) => {
    const installed = installDom()
    restore = installed.restore
    fireEvent = installed.fire
    container = installed.document.createElement("div")
    installed.document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => {
      root?.render(tree)
    })
    return container
  }

  const fire = (target: EventTarget | null, type: string) => {
    if (target === null || fireEvent === undefined) {
      throw new Error("missing event target")
    }
    fireEvent(target, type)
  }

  test("opens Implement now, Implement with..., Implement locally in that order", () => {
    const calls: string[] = []
    const node = render(
      <IssueActionsMenu
        {...defaultProps}
        canImplement
        canQueue={false}
        onImplementNow={() => calls.push("now")}
        onImplementWith={() => calls.push("with")}
        onImplementLocally={() => calls.push("locally")}
      />,
    )
    const kebab = node.querySelector("button[aria-haspopup='menu']")
    expect(kebab).not.toBeNull()
    flushSync(() => {
      fire(kebab, "click")
    })
    const items = [...node.querySelectorAll("[role='menuitem']")].map(
      (item) => item.textContent,
    )
    expect(items).toEqual([
      "Implement now",
      "Implement with...",
      "Implement locally",
    ])
  })

  test("blocked Issue kebab offers only Queue", () => {
    const node = render(
      <IssueActionsMenu {...defaultProps} canImplement={false} canQueue />,
    )
    const kebab = node.querySelector("button[aria-haspopup='menu']")
    flushSync(() => {
      fire(kebab, "click")
    })
    const items = [...node.querySelectorAll("[role='menuitem']")].map(
      (item) => item.textContent,
    )
    expect(items).toEqual(["Queue"])
  })

  test("Implement with... notifies without starting Implement now", () => {
    const calls: string[] = []
    const node = render(
      <IssueActionsMenu
        {...defaultProps}
        canImplement
        canQueue={false}
        onImplementNow={() => calls.push("now")}
        onImplementWith={() => calls.push("with")}
        onImplementLocally={() => calls.push("locally")}
      />,
    )
    const kebab = node.querySelector("button[aria-haspopup='menu']")
    flushSync(() => {
      fire(kebab, "click")
    })
    const withItem = [...node.querySelectorAll("[role='menuitem']")].find(
      (item) => item.textContent === "Implement with...",
    )
    flushSync(() => {
      fire(withItem ?? null, "click")
    })
    expect(calls).toEqual(["with"])
  })
})
