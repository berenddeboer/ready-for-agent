import { isUnavailableCatalogModel } from "../src/agent-model-settings.js"
import {
  executionProfileInputFromDraft,
  implementWithCatalogBlockReason,
  implementWithSessionPreview,
  nextImplementWithCatalogPin,
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
  const laterReady = {
    kind: "READY",
    models: [{ id: "haiku", thinkingLevels: ["low"] }],
  }

  const catalogMember = (
    usable: { readonly models: readonly { readonly id: string }[] | undefined },
    modelId: string,
  ): boolean =>
    !isUnavailableCatalogModel({
      modelId,
      catalogModelIds: (usable.models ?? []).map((model) => model.id),
    })

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

  test("keeps the first READY catalog when a later preview is Unavailable, failed, or empty", () => {
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: ready,
    })
    expect(
      usablePreviewCatalog({
        preview: { kind: "UNAVAILABLE", models: [] },
        previewFailed: false,
        pin,
      }),
    ).toEqual({ models: ready.models, failed: false })
    expect(
      usablePreviewCatalog({
        preview: undefined,
        previewFailed: true,
        pin,
      }),
    ).toEqual({ models: ready.models, failed: false })
    expect(
      usablePreviewCatalog({
        preview: { kind: "READY", models: [] },
        previewFailed: false,
        pin,
      }),
    ).toEqual({ models: ready.models, failed: false })
  })

  test("keeps the first READY catalog when a later preview is READY with a different list", () => {
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: ready,
    })
    expect(
      usablePreviewCatalog({
        preview: laterReady,
        previewFailed: false,
        pin,
      }),
    ).toEqual({ models: ready.models, failed: false })
  })

  test("a model listed only in the first READY catalog stays a member after a later preview", () => {
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: ready,
    })
    const usable = usablePreviewCatalog({
      preview: laterReady,
      previewFailed: false,
      pin,
    })
    expect(catalogMember(usable, "sonnet")).toBe(true)
  })

  test("a model absent from the first READY catalog stays a non-member", () => {
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: ready,
    })
    const usable = usablePreviewCatalog({
      preview: laterReady,
      previewFailed: false,
      pin,
    })
    expect(catalogMember(usable, "haiku")).toBe(false)
    expect(catalogMember(usable, "never-listed")).toBe(false)
  })

  test("with no prior READY catalog, Unavailable, failed, and loading stay as today", () => {
    expect(
      nextImplementWithCatalogPin({
        pin: undefined,
        preview: { kind: "UNAVAILABLE", models: [] },
      }),
    ).toBeUndefined()
    expect(
      nextImplementWithCatalogPin({
        pin: undefined,
        preview: undefined,
      }),
    ).toBeUndefined()
    expect(
      usablePreviewCatalog({
        preview: { kind: "UNAVAILABLE", models: [] },
        previewFailed: false,
        pin: undefined,
      }),
    ).toEqual({ models: [], failed: true })
    expect(
      usablePreviewCatalog({
        preview: undefined,
        previewFailed: true,
        pin: undefined,
      }),
    ).toEqual({ models: undefined, failed: true })
    expect(
      usablePreviewCatalog({
        preview: undefined,
        previewFailed: false,
        pin: undefined,
      }),
    ).toEqual({ models: undefined, failed: false })
  })

  test("a new dialog session with no pin uses the new preview", () => {
    expect(
      nextImplementWithCatalogPin({
        pin: undefined,
        preview: laterReady,
      }),
    ).toEqual({ models: laterReady.models })
    expect(
      usablePreviewCatalog({
        preview: laterReady,
        previewFailed: false,
        pin: undefined,
      }),
    ).toEqual({ models: laterReady.models, failed: false })
  })

  test("a new session does not pin leftover cached READY before this observer fetches", () => {
    const leftover = implementWithSessionPreview({
      pin: undefined,
      preview: ready,
      fetchedAfterMount: false,
      previewFailed: false,
    })
    expect(leftover).toEqual({ preview: undefined, previewFailed: false })
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: leftover.preview,
    })
    expect(pin).toBeUndefined()
    expect(
      usablePreviewCatalog({
        preview: leftover.preview,
        previewFailed: leftover.previewFailed,
        pin,
      }),
    ).toEqual({ models: undefined, failed: false })
  })

  test("a new session uses the remount fetch, not leftover cached READY", () => {
    const afterUnavailable = implementWithSessionPreview({
      pin: undefined,
      preview: { kind: "UNAVAILABLE", models: [] },
      fetchedAfterMount: true,
      previewFailed: false,
    })
    const unavailablePin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: afterUnavailable.preview,
    })
    expect(
      usablePreviewCatalog({
        preview: afterUnavailable.preview,
        previewFailed: afterUnavailable.previewFailed,
        pin: unavailablePin,
      }),
    ).toEqual({ models: [], failed: true })

    const afterDifferentReady = implementWithSessionPreview({
      pin: undefined,
      preview: laterReady,
      fetchedAfterMount: true,
      previewFailed: false,
    })
    const freshPin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: afterDifferentReady.preview,
    })
    expect(
      usablePreviewCatalog({
        preview: afterDifferentReady.preview,
        previewFailed: afterDifferentReady.previewFailed,
        pin: freshPin,
      }),
    ).toEqual({ models: laterReady.models, failed: false })
  })

  test("an in-session pin still applies while a backend switch-back is refetching", () => {
    const pin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: ready,
    })
    const refetching = implementWithSessionPreview({
      pin,
      preview: laterReady,
      fetchedAfterMount: false,
      previewFailed: false,
    })
    expect(
      usablePreviewCatalog({
        preview: refetching.preview,
        previewFailed: refetching.previewFailed,
        pin,
      }),
    ).toEqual({ models: ready.models, failed: false })
  })

  test("switching backends reuses this session's first READY catalog for that backend", () => {
    const opencodePin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: ready,
    })
    const grokReady = {
      kind: "READY",
      models: [{ id: "grok-code", thinkingLevels: ["low"] }],
    }
    const grokPin = nextImplementWithCatalogPin({
      pin: undefined,
      preview: grokReady,
    })
    expect(
      usablePreviewCatalog({
        preview: laterReady,
        previewFailed: false,
        pin: opencodePin,
      }),
    ).toEqual({ models: ready.models, failed: false })
    expect(
      usablePreviewCatalog({
        preview: { kind: "UNAVAILABLE", models: [] },
        previewFailed: false,
        pin: grokPin,
      }),
    ).toEqual({ models: grokReady.models, failed: false })
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
