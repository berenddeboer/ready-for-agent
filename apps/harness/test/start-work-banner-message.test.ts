import { startWorkBannerMessage } from "../src/start-work-banner-message.js"
import { describe, expect, test } from "bun:test"

const catalogMessage =
  'Build Agent Model "grok-4.5" is not in the current Grok Build Agent Model catalog. Choose a model the Agent Backend currently offers in Settings, then start this work again.'

const startFallback =
  "Could not start implementation. Refresh the issues and try again."

const queueFallback = "Could not queue issue. Refresh the issues and try again."

const implementAllFallback =
  "Could not start Implement all with auto-merge. Refresh the issues and try again."

describe("start-work Banner copy (issue #992)", () => {
  test("shows a present GraphQL Error.message instead of the generic fallback", () => {
    expect(
      startWorkBannerMessage({
        error: new Error(catalogMessage),
        fallback: startFallback,
      }),
    ).toBe(catalogMessage)
  })

  test("keeps each action's generic fallback when the failure is not an Error", () => {
    expect(
      startWorkBannerMessage({
        error: "BUILD_MODEL_NOT_CONFIGURED",
        fallback: startFallback,
      }),
    ).toBe(startFallback)
    expect(
      startWorkBannerMessage({
        error: { message: catalogMessage },
        fallback: queueFallback,
      }),
    ).toBe(queueFallback)
    expect(
      startWorkBannerMessage({
        error: null,
        fallback: implementAllFallback,
      }),
    ).toBe(implementAllFallback)
  })

  test("keeps the generic fallback when Error.message is empty", () => {
    expect(
      startWorkBannerMessage({
        error: new Error(""),
        fallback: startFallback,
      }),
    ).toBe(startFallback)
  })
})
