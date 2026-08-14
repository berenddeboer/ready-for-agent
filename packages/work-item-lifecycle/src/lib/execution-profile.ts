import { InvalidExecutionProfileError } from "./errors.js"
import type { AgentModelSelection } from "./resolve-agent-models.js"

/** Review selection stored as intent, not only resolved values. */
export type ExecutionProfileReviewSelection =
  | { readonly kind: "same_as_build" }
  | {
      readonly kind: "explicit"
      readonly model: string
      readonly thinkingLevel: string | null
    }

/**
 * Complete immutable Explicit Work Item Execution Profile. Partial profiles
 * cannot be constructed: review is either same-as-build or a full explicit
 * model (+ optional Thinking Level).
 */
export type ExplicitWorkItemExecutionProfile = {
  readonly agentBackend: string
  readonly build: {
    readonly model: string
    readonly thinkingLevel: string | null
  }
  readonly review: ExecutionProfileReviewSelection
}

/** GraphQL / command wire shape for Implement With. */
export type ImplementWithProfileInput = {
  readonly agentBackendId: string
  readonly buildModel: string
  readonly buildThinkingLevel: string | null
  readonly reviewSameAsBuild: boolean
  readonly reviewModel: string | null
  readonly reviewThinkingLevel: string | null
}

const trimmedOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Decode a complete profile from Implement With input. Rejects partial
 * profiles (missing build, same-as-build with review fields, or explicit
 * review without a model).
 */
export const decodeImplementWithProfile = (
  input: ImplementWithProfileInput,
): ExplicitWorkItemExecutionProfile | InvalidExecutionProfileError => {
  const agentBackend = trimmedOrNull(input.agentBackendId)
  if (agentBackend === null) {
    return new InvalidExecutionProfileError({
      message: "Implement With requires a shipped Agent Backend",
      field: "agentBackendId",
    })
  }
  const buildModel = trimmedOrNull(input.buildModel)
  if (buildModel === null) {
    return new InvalidExecutionProfileError({
      message: "Implement With requires a build Agent Model",
      field: "buildModel",
    })
  }
  const buildThinkingLevel = trimmedOrNull(input.buildThinkingLevel)
  const reviewModel = trimmedOrNull(input.reviewModel)
  const reviewThinkingLevel = trimmedOrNull(input.reviewThinkingLevel)
  if (input.reviewSameAsBuild) {
    if (reviewModel !== null || reviewThinkingLevel !== null) {
      return new InvalidExecutionProfileError({
        message:
          "Same as build cannot include a distinct review Agent Model or Thinking Level",
        field: "reviewSameAsBuild",
      })
    }
    return {
      agentBackend,
      build: { model: buildModel, thinkingLevel: buildThinkingLevel },
      review: { kind: "same_as_build" },
    }
  }
  if (reviewModel === null) {
    return new InvalidExecutionProfileError({
      message:
        "Implement With requires a review Agent Model unless Same as build is selected",
      field: "reviewModel",
    })
  }
  return {
    agentBackend,
    build: { model: buildModel, thinkingLevel: buildThinkingLevel },
    review: {
      kind: "explicit",
      model: reviewModel,
      thinkingLevel: reviewThinkingLevel,
    },
  }
}

/** Resolve same-as-build to exactly the build model and Thinking Level. */
export const resolveExecutionProfileSelection = (
  profile: ExplicitWorkItemExecutionProfile,
): AgentModelSelection => {
  const { model, thinkingLevel } = profile.build
  if (profile.review.kind === "same_as_build") {
    return {
      model,
      thinkingLevel,
      reviewModel: model,
      reviewThinkingLevel: thinkingLevel,
    }
  }
  return {
    model,
    thinkingLevel,
    reviewModel: profile.review.model,
    reviewThinkingLevel: profile.review.thinkingLevel,
  }
}

export type ExecutionProfileCatalogModel = {
  readonly id: string
  readonly thinkingLevels: ReadonlyArray<string>
}

const thinkingLevelViolationMessage = (input: {
  readonly role: string
  readonly model: string
  readonly thinkingLevel: string
  readonly backendLabel: string
}): string =>
  `${input.role} Thinking Level "${input.thinkingLevel}" is not offered by Agent Model "${input.model}" on ${input.backendLabel}. The Explicit Work Item Execution Profile cannot substitute another effort. Reset this Work Item and create a new attempt with a current catalog choice.`

/**
 * Validate Implement With catalog-only rules: non-empty catalog, model
 * membership, and Thinking Levels derived from the chosen models.
 */
export const validateExecutionProfileCatalog = (input: {
  readonly backendLabel: string
  readonly catalog: ReadonlyArray<ExecutionProfileCatalogModel>
  readonly profile: ExplicitWorkItemExecutionProfile
}): InvalidExecutionProfileError | null => {
  if (input.catalog.length === 0) {
    return new InvalidExecutionProfileError({
      message: `Implement With requires a non-empty Agent Model catalog for ${input.backendLabel}. The selected Agent Backend reported no models.`,
      field: "buildModel",
    })
  }
  const selection = resolveExecutionProfileSelection(input.profile)
  const byId = new Map(input.catalog.map((model) => [model.id, model] as const))
  const checked: ReadonlyArray<
    readonly [
      role: string,
      field: string,
      model: string,
      thinkingLevel: string | null,
    ]
  > = [
    ["Build", "buildModel", selection.model, selection.thinkingLevel],
    [
      "Review",
      input.profile.review.kind === "same_as_build"
        ? "reviewSameAsBuild"
        : "reviewModel",
      selection.reviewModel,
      selection.reviewThinkingLevel,
    ],
  ]
  for (const [role, field, model, thinkingLevel] of checked) {
    const catalogModel = byId.get(model)
    if (catalogModel === undefined) {
      return new InvalidExecutionProfileError({
        message: `${role} Agent Model "${model}" is not in the current ${input.backendLabel} Agent Model catalog. Choose a model the Agent Backend currently offers.`,
        field,
      })
    }
    if (thinkingLevel === null) continue
    if (!catalogModel.thinkingLevels.includes(thinkingLevel)) {
      return new InvalidExecutionProfileError({
        message: thinkingLevelViolationMessage({
          role,
          model,
          thinkingLevel,
          backendLabel: input.backendLabel,
        }),
        field: role === "Build" ? "buildThinkingLevel" : "reviewThinkingLevel",
      })
    }
  }
  return null
}
