import { InvalidExecutionProfileError } from "../src/lib/errors.js"
import {
  decodeImplementWithOptions,
  decodeImplementWithProfile,
  resolveExecutionProfileSelection,
  validateExecutionProfileCatalog,
} from "../src/lib/execution-profile.js"
import { describe, expect, it } from "bun:test"

const catalog = [
  { id: "build-model", thinkingLevels: ["low", "high"] },
  { id: "review-model", thinkingLevels: ["max"] },
] as const

describe("decodeImplementWithProfile", () => {
  it("decodes a complete explicit profile", () => {
    expect(
      decodeImplementWithProfile({
        agentBackendId: "opencode",
        buildModel: "build-model",
        buildThinkingLevel: "high",
        reviewSameAsBuild: false,
        reviewModel: "review-model",
        reviewThinkingLevel: "max",
      }),
    ).toEqual({
      agentBackend: "opencode",
      build: { model: "build-model", thinkingLevel: "high" },
      review: {
        kind: "explicit",
        model: "review-model",
        thinkingLevel: "max",
      },
    })
  })

  it("persists Same as build as intent rather than a duplicated review model", () => {
    const profile = decodeImplementWithProfile({
      agentBackendId: "grok",
      buildModel: "build-model",
      buildThinkingLevel: "low",
      reviewSameAsBuild: true,
      reviewModel: null,
      reviewThinkingLevel: null,
    })
    expect(profile).toEqual({
      agentBackend: "grok",
      build: { model: "build-model", thinkingLevel: "low" },
      review: { kind: "same_as_build" },
    })
    if (!("_tag" in profile)) {
      expect(resolveExecutionProfileSelection(profile)).toEqual({
        model: "build-model",
        thinkingLevel: "low",
        reviewModel: "build-model",
        reviewThinkingLevel: "low",
      })
    }
  })

  it("rejects a missing build model", () => {
    const error = decodeImplementWithProfile({
      agentBackendId: "opencode",
      buildModel: "  ",
      buildThinkingLevel: null,
      reviewSameAsBuild: true,
      reviewModel: null,
      reviewThinkingLevel: null,
    })
    expect(error).toBeInstanceOf(InvalidExecutionProfileError)
    expect(error).toMatchObject({ field: "buildModel" })
  })

  it("rejects Same as build together with an explicit review model", () => {
    const error = decodeImplementWithProfile({
      agentBackendId: "opencode",
      buildModel: "build-model",
      buildThinkingLevel: null,
      reviewSameAsBuild: true,
      reviewModel: "review-model",
      reviewThinkingLevel: null,
    })
    expect(error).toBeInstanceOf(InvalidExecutionProfileError)
    expect(error).toMatchObject({ field: "reviewSameAsBuild" })
  })

  it("rejects an explicit review selection without a review model", () => {
    const error = decodeImplementWithProfile({
      agentBackendId: "opencode",
      buildModel: "build-model",
      buildThinkingLevel: null,
      reviewSameAsBuild: false,
      reviewModel: null,
      reviewThinkingLevel: "high",
    })
    expect(error).toBeInstanceOf(InvalidExecutionProfileError)
    expect(error).toMatchObject({ field: "reviewModel" })
  })
})

describe("decodeImplementWithOptions", () => {
  it("treats omitted options as repository-inherited remote behavior", () => {
    expect(decodeImplementWithOptions()).toEqual({
      mergePolicy: null,
      implementLocally: false,
    })
    expect(decodeImplementWithOptions({})).toEqual({
      mergePolicy: null,
      implementLocally: false,
    })
  })

  it("persists a concrete Merge Policy pin and the local inspection pause", () => {
    expect(
      decodeImplementWithOptions({
        mergePolicy: "classify",
        implementLocally: true,
      }),
    ).toEqual({
      mergePolicy: "classify",
      implementLocally: true,
    })
    expect(
      decodeImplementWithOptions({
        mergePolicy: "off",
        implementLocally: false,
      }),
    ).toEqual({
      mergePolicy: "off",
      implementLocally: false,
    })
    expect(
      decodeImplementWithOptions({
        mergePolicy: "always",
        implementLocally: false,
      }),
    ).toEqual({
      mergePolicy: "always",
      implementLocally: false,
    })
  })
})

describe("validateExecutionProfileCatalog", () => {
  const profile = {
    agentBackend: "opencode",
    build: { model: "build-model", thinkingLevel: "high" as string | null },
    review: { kind: "same_as_build" as const },
  }

  it("rejects an empty catalog", () => {
    const error = validateExecutionProfileCatalog({
      backendLabel: "OpenCode",
      catalog: [],
      profile,
    })
    expect(error).toBeInstanceOf(InvalidExecutionProfileError)
    expect(error?.message).toContain("non-empty Agent Model catalog")
  })

  it("rejects a model that is not in the catalog", () => {
    const error = validateExecutionProfileCatalog({
      backendLabel: "OpenCode",
      catalog,
      profile: {
        ...profile,
        build: { model: "missing", thinkingLevel: null },
      },
    })
    expect(error).toBeInstanceOf(InvalidExecutionProfileError)
    expect(error?.message).toContain("missing")
  })

  it("rejects a Thinking Level the chosen model does not offer", () => {
    const error = validateExecutionProfileCatalog({
      backendLabel: "OpenCode",
      catalog,
      profile: {
        ...profile,
        build: { model: "build-model", thinkingLevel: "max" },
      },
    })
    expect(error).toBeInstanceOf(InvalidExecutionProfileError)
    expect(error?.message).toContain("max")
    expect(error?.message).toContain("cannot substitute another effort")
  })

  it("accepts a complete catalog-valid profile", () => {
    expect(
      validateExecutionProfileCatalog({
        backendLabel: "OpenCode",
        catalog,
        profile,
      }),
    ).toBeNull()
  })
})
