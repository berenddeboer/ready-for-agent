import { createHash } from "node:crypto"
import { Schema } from "effect"

export const ClosedSpecDescendants = Schema.NonEmptyArray(
  Schema.Struct({
    nativeId: Schema.NonEmptyString,
    url: Schema.optionalKey(Schema.NonEmptyString),
    // Preserve the original tracker value; null means it was not supplied.
    closureReason: Schema.NullOr(Schema.String),
    // Older frozen inputs lack a closure timestamp. Live reads include it so
    // a descendant reopened and closed again is not the same observation.
    closedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    reopenEventId: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  }),
)
export type ClosedSpecDescendants = typeof ClosedSpecDescendants.Type

export const SpecConversation = Schema.Array(
  Schema.Struct({
    url: Schema.NonEmptyString,
    body: Schema.String,
    author: Schema.NullOr(Schema.String),
    // A user account is not proof that a human wrote the comment.
    authorKind: Schema.Literals(["user-account", "automation", "unknown"]),
  }),
)
export type SpecConversation = typeof SpecConversation.Type

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

export const SpecCloseResult = Schema.Literals([
  "closed",
  "waiting",
  "stale",
  "reopened",
])
export type SpecCloseResult = typeof SpecCloseResult.Type

export const SpecCloseGuard = Schema.Struct({
  hierarchyFingerprint: Schema.NonEmptyString,
  parentReopenEventId: Schema.NullOr(Schema.NonEmptyString),
})
export type SpecCloseGuard = typeof SpecCloseGuard.Type

// Keep the guarded close-out request bounded even for very large hierarchies.
export const specHierarchyFingerprint = (descendants: ClosedSpecDescendants) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        descendants
          .map(({ nativeId, closureReason, closedAt, reopenEventId }) =>
            JSON.stringify(
              reopenEventId === undefined
                ? [nativeId, closureReason, closedAt]
                : [nativeId, closureReason, closedAt, reopenEventId],
            ),
          )
          .sort(),
      ),
    )
    .digest("hex")

export const checkSpecHierarchy = (
  current:
    | { readonly readiness: "waiting" | "hierarchy-unavailable" }
    | {
        readonly readiness: "all-descendants-closed"
        readonly descendants: ClosedSpecDescendants
      }
    | undefined,
  validated: string,
): "current" | "waiting" | "stale" => {
  if (current?.readiness === "waiting") return "stale"
  if (current?.readiness !== "all-descendants-closed") return "waiting"
  if (current.descendants.some(({ closedAt }) => !closedAt)) return "waiting"
  return specHierarchyFingerprint(current.descendants) === validated
    ? "current"
    : "stale"
}
