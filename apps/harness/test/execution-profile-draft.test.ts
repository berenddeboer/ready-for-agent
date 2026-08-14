import {
  executionProfileInputFromDraft,
  implementWithCatalogBlockReason,
  reconcileExecutionProfileDraft,
  resolveExecutionProfileDraft,
  usablePreviewCatalog,
} from "../src/execution-profile-draft.js"
import { describe, expect, test } from "bun:test"

const emptyPrefs = {
  defaultModel: null,
  defaultThinkingLevel: null,
  reviewModel: null,
  reviewThinkingLevel: null,
}

describe("resolveExecutionProfileDraft", () => {
  test("uses Repository overrides over Harness preferences", () => {
    expect(
      resolveExecutionProfileDraft({
        repository: {
          defaultModel: "repo-build",
          defaultThinkingLevel: "high",
          reviewModel: "repo-review",
          reviewThinkingLevel: "low",
        },
        harness: {
          defaultModel: "harness-build",
          defaultThinkingLevel: "medium",
          reviewModel: "harness-review",
          reviewThinkingLevel: "high",
        },
      }),
    ).toEqual({
      buildModel: "repo-build",
      buildThinkingLevel: "high",
      reviewSameAsBuild: false,
      reviewModel: "repo-review",
      reviewThinkingLevel: "low",
    })
  })

  test("inherits Harness build and review when the Repository has no override", () => {
    expect(
      resolveExecutionProfileDraft({
        repository: emptyPrefs,
        harness: {
          defaultModel: "harness-build",
          defaultThinkingLevel: "medium",
          reviewModel: "harness-review",
          reviewThinkingLevel: "low",
        },
      }),
    ).toEqual({
      buildModel: "harness-build",
      buildThinkingLevel: "medium",
      reviewSameAsBuild: false,
      reviewModel: "harness-review",
      reviewThinkingLevel: "low",
    })
  })

  test("defaults review to Same as build when no review model is configured", () => {
    expect(
      resolveExecutionProfileDraft({
        repository: emptyPrefs,
        harness: {
          defaultModel: "build-only",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: "low",
        },
      }),
    ).toEqual({
      buildModel: "build-only",
      buildThinkingLevel: "high",
      reviewSameAsBuild: true,
    })
  })

  test("leaves a missing default build model as a blank required choice", () => {
    expect(
      resolveExecutionProfileDraft({
        repository: emptyPrefs,
        harness: emptyPrefs,
      }),
    ).toEqual({
      buildModel: "",
      buildThinkingLevel: "",
      reviewSameAsBuild: true,
    })
  })
})

describe("executionProfileInputFromDraft", () => {
  test("omits review fields when Same as build is selected", () => {
    expect(
      executionProfileInputFromDraft({
        agentBackendId: "opencode",
        draft: {
          buildModel: "build-model",
          buildThinkingLevel: "high",
          reviewSameAsBuild: true,
        },
      }),
    ).toEqual({
      agentBackendId: "opencode",
      buildModel: "build-model",
      buildThinkingLevel: "high",
      reviewSameAsBuild: true,
      reviewModel: null,
      reviewThinkingLevel: null,
    })
  })

  test("sends an explicit review selection including a blank Thinking Level as null", () => {
    expect(
      executionProfileInputFromDraft({
        agentBackendId: "grok",
        draft: {
          buildModel: "build-model",
          buildThinkingLevel: "",
          reviewSameAsBuild: false,
          reviewModel: "review-model",
          reviewThinkingLevel: "",
        },
      }),
    ).toEqual({
      agentBackendId: "grok",
      buildModel: "build-model",
      buildThinkingLevel: null,
      reviewSameAsBuild: false,
      reviewModel: "review-model",
      reviewThinkingLevel: null,
    })
  })
})

describe("usablePreviewCatalog", () => {
  const ready = {
    kind: "READY",
    models: [{ id: "sonnet", thinkingLevels: ["low", "high"] }],
  }

  test("keeps a cached READY catalog when a later preview fails", () => {
    expect(
      usablePreviewCatalog({ preview: ready, previewFailed: true }),
    ).toEqual({ models: ready.models, failed: false })
  })

  test("does not invent an empty catalog while preview has not settled", () => {
    expect(
      usablePreviewCatalog({ preview: undefined, previewFailed: false }),
    ).toEqual({ models: undefined, failed: false })
  })

  test("marks failure only when there is no READY catalog to keep", () => {
    expect(
      usablePreviewCatalog({ preview: undefined, previewFailed: true }),
    ).toEqual({ models: undefined, failed: true })
    expect(
      usablePreviewCatalog({
        preview: { kind: "UNAVAILABLE", models: [] },
        previewFailed: false,
      }),
    ).toEqual({ models: [], failed: true })
  })
})

describe("reconcileExecutionProfileDraft", () => {
  test("clears a Thinking Level the chosen model does not offer", () => {
    expect(
      reconcileExecutionProfileDraft({
        draft: {
          buildModel: "sonnet",
          buildThinkingLevel: "xhigh",
          reviewSameAsBuild: false,
          reviewModel: "haiku",
          reviewThinkingLevel: "max",
        },
        models: [
          { id: "sonnet", thinkingLevels: ["low", "high"] },
          { id: "haiku", thinkingLevels: ["low"] },
        ],
      }),
    ).toEqual({
      buildModel: "sonnet",
      buildThinkingLevel: "",
      reviewSameAsBuild: false,
      reviewModel: "haiku",
      reviewThinkingLevel: "",
    })
  })

  test("keeps current Thinking Levels until a catalog has loaded", () => {
    expect(
      reconcileExecutionProfileDraft({
        draft: {
          buildModel: "sonnet",
          buildThinkingLevel: "high",
          reviewSameAsBuild: false,
          reviewModel: "haiku",
          reviewThinkingLevel: "low",
        },
        models: undefined,
      }),
    ).toEqual({
      buildModel: "sonnet",
      buildThinkingLevel: "high",
      reviewSameAsBuild: false,
      reviewModel: "haiku",
      reviewThinkingLevel: "low",
    })
  })

  test("keeps compatible Thinking Levels", () => {
    expect(
      reconcileExecutionProfileDraft({
        draft: {
          buildModel: "sonnet",
          buildThinkingLevel: "high",
          reviewSameAsBuild: true,
        },
        models: [{ id: "sonnet", thinkingLevels: ["low", "high"] }],
      }),
    ).toEqual({
      buildModel: "sonnet",
      buildThinkingLevel: "high",
      reviewSameAsBuild: true,
    })
  })
})

describe("implementWithCatalogBlockReason", () => {
  test("does not send the operator to Recheck or Settings", () => {
    const empty = implementWithCatalogBlockReason({
      catalogLoading: false,
      catalogModels: [],
      modelId: "",
      requireSelection: true,
      backendId: "opencode",
    })
    expect(empty).toBe(
      "Implement With requires a non-empty Agent Model catalog.",
    )
    expect(empty).not.toContain("Recheck")
    expect(empty).not.toContain("Settings")

    const failed = implementWithCatalogBlockReason({
      catalogLoading: false,
      catalogFailed: true,
      catalogModels: undefined,
      modelId: "sonnet",
      requireSelection: true,
      backendId: "opencode",
    })
    expect(failed).toBe("Could not load the Agent Model catalog.")
    expect(failed).not.toContain("Recheck")
  })
})
