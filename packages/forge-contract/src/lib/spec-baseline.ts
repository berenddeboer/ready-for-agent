import { Schema } from "effect"

export const SPEC_LABEL = "spec"

export const SpecRequirementEnvironment = Schema.Literals([
  "local",
  "deployed",
  "other",
])
export type SpecRequirementEnvironment = typeof SpecRequirementEnvironment.Type

export const SpecBaseline = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
})
export type SpecBaseline = typeof SpecBaseline.Type

const reopening = Schema.optionalKey(
  Schema.NullOr(
    Schema.Struct({
      id: Schema.NonEmptyString,
      createdAt: Schema.NonEmptyString,
    }),
  ),
)

export const SpecBaselineResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-spec") }),
  Schema.Struct({
    kind: Schema.Literal("baseline"),
    baseline: SpecBaseline,
    reopening,
  }),
])
export type SpecBaselineResult = typeof SpecBaselineResult.Type

export interface SpecBaselineReadOptions {
  /** Read the latest native parent reopening as well as the current Spec text. */
  readonly includeReopening: boolean
}
