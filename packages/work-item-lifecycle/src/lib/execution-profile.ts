import { InvalidExecutionProfileError } from "./errors.js"
import type { MergePolicy } from "./merge-policy.js"
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

/**
 * Separate Implement With options. Omission leaves Work Item Merge Policy
 * unset (inherit) and keeps the remote path. A concrete `mergePolicy` is
 * a durable pin; Implement Locally is an optional inspection pause.
 */
export type ImplementWithOptionsInput = {
  readonly mergePolicy?: MergePolicy
  readonly implementLocally?: boolean
}

export const decodeImplementWithOptions = (
  options?: ImplementWithOptionsInput,
): {
  readonly mergePolicy: MergePolicy | null
  readonly implementLocally: boolean
} => ({
  mergePolicy: options?.mergePolicy ?? null,
  implementLocally: options?.implementLocally === true,
})

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

/**
 * Partial change to a pinned Explicit Work Item Execution Profile.
 * Omitted fields keep their current values. A present thinking-level
 * `null` clears that level.
 */
export type ExecutionProfileUpdatePatch = {
  readonly buildModel?: string
  readonly buildThinkingLevel?: string | null
  readonly reviewSameAsBuild?: boolean
  readonly reviewModel?: string
  readonly reviewThinkingLevel?: string | null
}

const patchSpecifiesChange = (patch: ExecutionProfileUpdatePatch): boolean =>
  patch.buildModel !== undefined ||
  patch.buildThinkingLevel !== undefined ||
  patch.reviewSameAsBuild !== undefined ||
  patch.reviewModel !== undefined ||
  patch.reviewThinkingLevel !== undefined

const updateThinkingLevelMessage = (input: {
  readonly role: string
  readonly model: string
  readonly thinkingLevel: string
  readonly backendLabel: string
  readonly offered: ReadonlyArray<string>
}): string => {
  const offered =
    input.offered.length === 0
      ? "none"
      : input.offered.map((level) => `"${level}"`).join(", ")
  return `${input.role} Thinking Level "${input.thinkingLevel}" is not offered by Agent Model "${input.model}" on ${input.backendLabel} (offers ${offered}). Pass a Thinking Level this Agent Model offers. The change does not pick a substitute.`
}

const reconcileThinkingLevel = (input: {
  readonly role: string
  readonly field: string
  readonly model: string
  readonly thinkingLevel: string | null
  readonly explicitlySet: boolean
  readonly catalogModel: ExecutionProfileCatalogModel
  readonly backendLabel: string
}): string | null | InvalidExecutionProfileError => {
  const { thinkingLevel, catalogModel } = input
  if (thinkingLevel === null) return null
  if (catalogModel.thinkingLevels.includes(thinkingLevel)) return thinkingLevel
  if (!input.explicitlySet && catalogModel.thinkingLevels.length === 0) {
    return null
  }
  return new InvalidExecutionProfileError({
    message: updateThinkingLevelMessage({
      role: input.role,
      model: input.model,
      thinkingLevel,
      backendLabel: input.backendLabel,
      offered: catalogModel.thinkingLevels,
    }),
    field: input.field,
  })
}

/**
 * Merge a partial pin change onto the current profile and validate it
 * against the Work Item's Agent Backend catalog. A kept thinking level
 * that the new model does not offer is rejected when that model offers
 * levels. A leftover level is cleared only when the model offers none.
 */
export const applyExecutionProfileUpdate = (input: {
  readonly current: ExplicitWorkItemExecutionProfile
  readonly patch: ExecutionProfileUpdatePatch
  readonly catalog: ReadonlyArray<ExecutionProfileCatalogModel>
  readonly backendLabel: string
}): ExplicitWorkItemExecutionProfile | InvalidExecutionProfileError => {
  if (!patchSpecifiesChange(input.patch)) {
    return new InvalidExecutionProfileError({
      message:
        "Set at least one of build model, build Thinking Level, review model, review Thinking Level, or Same as build",
      field: "profile",
    })
  }
  if (input.catalog.length === 0) {
    return new InvalidExecutionProfileError({
      message: `Cannot change the Explicit Work Item Execution Profile because ${input.backendLabel} reported no Agent Models. Recheck the Agent Backend and try again.`,
      field: "buildModel",
    })
  }

  const patch = input.patch
  const reviewModel = trimmedOrNull(patch.reviewModel)
  const reviewThinkingLevel =
    patch.reviewThinkingLevel === undefined
      ? undefined
      : trimmedOrNull(patch.reviewThinkingLevel)
  if (patch.reviewSameAsBuild === true) {
    if (reviewModel !== null || reviewThinkingLevel != null) {
      return new InvalidExecutionProfileError({
        message:
          "Same as build cannot include a distinct review Agent Model or Thinking Level",
        field: "reviewSameAsBuild",
      })
    }
  }

  let buildModel = input.current.build.model
  if (patch.buildModel !== undefined) {
    const next = trimmedOrNull(patch.buildModel)
    if (next === null) {
      return new InvalidExecutionProfileError({
        message: "Build Agent Model cannot be empty",
        field: "buildModel",
      })
    }
    buildModel = next
  }
  let buildThinkingLevel = input.current.build.thinkingLevel
  if (patch.buildThinkingLevel !== undefined) {
    buildThinkingLevel = trimmedOrNull(patch.buildThinkingLevel)
  }

  let review = input.current.review
  if (patch.reviewSameAsBuild === true) {
    review = { kind: "same_as_build" }
  } else if (patch.reviewModel !== undefined) {
    if (reviewModel === null) {
      return new InvalidExecutionProfileError({
        message: "Review Agent Model cannot be empty",
        field: "reviewModel",
      })
    }
    review = {
      kind: "explicit",
      model: reviewModel,
      thinkingLevel:
        reviewThinkingLevel !== undefined
          ? reviewThinkingLevel
          : input.current.review.kind === "explicit"
            ? input.current.review.thinkingLevel
            : null,
    }
  } else if (reviewThinkingLevel !== undefined) {
    if (review.kind !== "explicit") {
      return new InvalidExecutionProfileError({
        message:
          "A review Thinking Level needs an explicit review Agent Model. Pass a review model, or use Same as build.",
        field: "reviewThinkingLevel",
      })
    }
    review = { ...review, thinkingLevel: reviewThinkingLevel }
  } else if (
    patch.reviewSameAsBuild === false &&
    review.kind === "same_as_build"
  ) {
    return new InvalidExecutionProfileError({
      message: "Turning off Same as build requires a review Agent Model",
      field: "reviewModel",
    })
  }

  const byId = new Map(input.catalog.map((model) => [model.id, model] as const))
  const buildCatalog = byId.get(buildModel)
  if (buildCatalog === undefined) {
    return new InvalidExecutionProfileError({
      message: `Build Agent Model "${buildModel}" is not in the current ${input.backendLabel} Agent Model catalog. Choose a model the Agent Backend currently offers.`,
      field: "buildModel",
    })
  }
  const reconciledBuildLevel = reconcileThinkingLevel({
    role: "Build",
    field: "buildThinkingLevel",
    model: buildModel,
    thinkingLevel: buildThinkingLevel,
    explicitlySet: patch.buildThinkingLevel !== undefined,
    catalogModel: buildCatalog,
    backendLabel: input.backendLabel,
  })
  if (reconciledBuildLevel instanceof InvalidExecutionProfileError) {
    return reconciledBuildLevel
  }

  let reconciledReview = review
  if (review.kind === "explicit") {
    const reviewCatalog = byId.get(review.model)
    if (reviewCatalog === undefined) {
      return new InvalidExecutionProfileError({
        message: `Review Agent Model "${review.model}" is not in the current ${input.backendLabel} Agent Model catalog. Choose a model the Agent Backend currently offers.`,
        field: "reviewModel",
      })
    }
    const reconciledReviewLevel = reconcileThinkingLevel({
      role: "Review",
      field: "reviewThinkingLevel",
      model: review.model,
      thinkingLevel: review.thinkingLevel,
      explicitlySet: patch.reviewThinkingLevel !== undefined,
      catalogModel: reviewCatalog,
      backendLabel: input.backendLabel,
    })
    if (reconciledReviewLevel instanceof InvalidExecutionProfileError) {
      return reconciledReviewLevel
    }
    reconciledReview = {
      kind: "explicit",
      model: review.model,
      thinkingLevel: reconciledReviewLevel,
    }
  }

  const profile: ExplicitWorkItemExecutionProfile = {
    agentBackend: input.current.agentBackend,
    build: { model: buildModel, thinkingLevel: reconciledBuildLevel },
    review: reconciledReview,
  }
  return (
    validateExecutionProfileCatalog({
      backendLabel: input.backendLabel,
      catalog: input.catalog,
      profile,
    }) ?? profile
  )
}
