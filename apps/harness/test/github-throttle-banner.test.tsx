import { renderToStaticMarkup } from "react-dom/server"
import { GitHubThrottleBanner } from "../src/github-throttle-banner.js"
import { describe, expect, test } from "bun:test"

describe("GitHubThrottleBanner", () => {
  test("renders the throttle deadline and clears when it is absent", () => {
    const visible = renderToStaticMarkup(
      <GitHubThrottleBanner retryAt="2026-08-07T12:00:00.000Z" />,
    )
    const cleared = renderToStaticMarkup(
      <GitHubThrottleBanner retryAt={null} />,
    )

    expect(visible).toContain('role="alert"')
    expect(visible).toContain("GitHub")
    expect(visible).toContain("GitHub is throttling Harness requests until")
    expect(cleared).toBe("")
  })
})
