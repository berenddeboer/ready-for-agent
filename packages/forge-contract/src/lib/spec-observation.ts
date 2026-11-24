import { Schema } from "effect"

export const ClosedSpecDescendants = Schema.NonEmptyArray(
  Schema.Struct({
    nativeId: Schema.NonEmptyString,
    // Preserve the original tracker value; null means it was not supplied.
    closureReason: Schema.NullOr(Schema.String),
  }),
)
export type ClosedSpecDescendants = typeof ClosedSpecDescendants.Type

const identity = {
  nativeId: Schema.NonEmptyString,
  displayId: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
}
export const SpecObservation = Schema.Union([
  Schema.Struct({
    ...identity,
    readiness: Schema.Literals(["waiting", "hierarchy-unavailable"]),
  }),
  Schema.Struct({
    ...identity,
    readiness: Schema.Literal("all-descendants-closed"),
    descendants: ClosedSpecDescendants,
  }),
])
export type SpecObservation = typeof SpecObservation.Type
