import { renderToStaticMarkup } from "react-dom/server"
import { WorkItemResetButton } from "../src/work-item-reset-button.js"
import { describe, expect, test } from "bun:test"

describe("WorkItemResetButton", () => {
  test("renders the compact copper reset control with an accessible label", () => {
    const html = renderToStaticMarkup(
      <WorkItemResetButton
        pending={false}
        disabled={false}
        onReset={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="Reset job"')
    expect(html).toContain('aria-busy="false"')
    expect(html).toContain("data-work-item-reset-control")
    expect(html).toContain("h-[2.125rem] w-9")
    expect(html).toContain(">R</span>")
    expect(html).not.toContain("<svg")
  })

  test("announces and animates the pending reset", () => {
    const html = renderToStaticMarkup(
      <WorkItemResetButton pending disabled onReset={() => undefined} />,
    )

    expect(html).toContain('aria-label="Resetting job"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-pending="true"')
    expect(html).toContain("disabled")
    expect(html).toContain("work-item-reset-ticket")
    expect(html).toContain("work-item-reset-lid")
  })
})
