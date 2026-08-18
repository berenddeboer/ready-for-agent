import type { MergePolicy } from "@ready-for-agent/db-service"

export type { MergePolicy }

export const decodeMergePolicy = (value: unknown): MergePolicy => {
  if (value === "classify" || value === "always" || value === "off") {
    return value
  }
  return "off"
}

export const decodeMergeMode = (
  value: string | null | undefined,
): "ordinary" | "always" => (value === "always" ? "always" : "ordinary")

export const decodeWorkItemAutoMergeOverride = (
  value: boolean | number | null | undefined,
): boolean | null =>
  value === null || value === undefined ? null : Boolean(value)

/**
 * Effective Merge Policy at merge-routing time.
 * A concrete pin wins; an unset pin inherits the live Repository policy.
 *
 * Encoding: Merge Mode `always` = pin `always`; ordinary + override true =
 * pin `classify`; ordinary + override false = pin `off`; ordinary +
 * override null = unpinned.
 */
export const resolveEffectiveMergePolicy = (input: {
  readonly repositoryMergePolicy: MergePolicy
  readonly workItemMergeMode: string | null | undefined
  readonly workItemAutoMergeOverride: boolean | number | null | undefined
}): MergePolicy => {
  if (decodeMergeMode(input.workItemMergeMode) === "always") {
    return "always"
  }
  const override = decodeWorkItemAutoMergeOverride(
    input.workItemAutoMergeOverride,
  )
  if (override === false) {
    return "off"
  }
  if (override === true) {
    return "classify"
  }
  return input.repositoryMergePolicy
}

export const nextStateAfterReadyForMerge = (
  policy: MergePolicy,
): "decide_pr_merge" | "merge_pr" =>
  policy === "always" ? "merge_pr" : "decide_pr_merge"

export const isAlwaysNoChecksCarveOut = (
  policy: MergePolicy,
  statusTag: string,
): boolean => policy === "always" && statusTag === "no_checks"

export const isAutonomousMergePolicy = (policy: MergePolicy): boolean =>
  policy === "always" || policy === "classify"
