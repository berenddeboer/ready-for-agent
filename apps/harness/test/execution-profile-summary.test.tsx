import { renderToStaticMarkup } from "react-dom/server"
import { ExecutionProfileSummary } from "../src/execution-profile-summary.js"
import { describe, expect, test } from "bun:test"

describe("ExecutionProfileSummary", () => {
  test("hides settings-resolved Work Items", () => {
    expect(
      renderToStaticMarkup(<ExecutionProfileSummary profile={null} />),
    ).toBe("")
  })

  test("marks an explicit profile and shows backend, build, review, and Thinking Levels", () => {
    const html = renderToStaticMarkup(
      <ExecutionProfileSummary
        profile={{
          backend: { id: "opencode", label: "OpenCode" },
          buildModel: "big-pickle",
          buildThinkingLevel: "high",
          reviewSameAsBuild: false,
          reviewModel: "sonnet",
          reviewThinkingLevel: "low",
        }}
      />,
    )
    expect(html).toContain("Explicit Work Item Execution Profile")
    expect(html).toContain("OpenCode")
    expect(html).toContain("Build big-pickle · High")
    expect(html).toContain("Review sonnet · Low")
  })

  test("shows Same as build for review intent", () => {
    const html = renderToStaticMarkup(
      <ExecutionProfileSummary
        profile={{
          backend: { id: "grok", label: "Grok Build" },
          buildModel: "grok-code",
          buildThinkingLevel: null,
          reviewSameAsBuild: true,
          reviewModel: "grok-code",
          reviewThinkingLevel: null,
        }}
      />,
    )
    expect(html).toContain("Grok Build")
    expect(html).toContain("Build grok-code")
    expect(html).toContain("Review Same as build")
    expect(html).not.toContain("Review grok-code")
  })

  test("root wrapper constrains width with shrink/min-width and preserves caller className", () => {
    const html = renderToStaticMarkup(
      <ExecutionProfileSummary
        className="mt-[0.25rem]"
        profile={{
          backend: {
            id: "opencode",
            label: "OpenCode",
          },
          buildModel:
            "anthropic/claude-sonnet-4-20250514/qualified-very-long-provider-model-identifier",
          buildThinkingLevel: "extended",
          reviewSameAsBuild: false,
          reviewModel:
            "openai/gpt-5.1/qualified-very-long-provider-model-identifier",
          reviewThinkingLevel: "extended",
        }}
      />,
    )
    expect(html).toMatch(
      /<div class="min-w-0 max-w-full mt-\[0\.25rem\]" data-execution-profile/,
    )
  })
})
