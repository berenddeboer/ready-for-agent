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
 * Decode the stored Merge Mode + override columns as a Work Item Merge
 * Policy pin. `null` means inherit the live Repository Merge Policy.
 *
 * Encoding: Merge Mode `always` = pin `always`; ordinary + override true =
 * pin `classify`; ordinary + override false = pin `off`; ordinary +
 * override null = unpinned.
 */
export const decodeWorkItemMergePolicy = (input: {
  readonly workItemMergeMode: string | null | undefined
  readonly workItemAutoMergeOverride: boolean | number | null | undefined
}): MergePolicy | null => {
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
  return null
}

/** Persist a concrete Work Item Merge Policy pin in the existing columns. */
export const encodeWorkItemMergePolicyPin = (
  pin: MergePolicy,
): {
  readonly mergeMode: "ordinary" | "always"
  readonly autoMergeOverride: boolean | null
} => {
  switch (pin) {
    case "always":
      return { mergeMode: "always", autoMergeOverride: null }
    case "classify":
      return { mergeMode: "ordinary", autoMergeOverride: true }
    case "off":
      return { mergeMode: "ordinary", autoMergeOverride: false }
  }
}

/**
 * Effective Merge Policy at merge-routing time.
 * A concrete pin wins; an unset pin inherits the live Repository policy.
 */
export const resolveEffectiveMergePolicy = (input: {
  readonly repositoryMergePolicy: MergePolicy
  readonly workItemMergeMode: string | null | undefined
  readonly workItemAutoMergeOverride: boolean | number | null | undefined
}): MergePolicy =>
  decodeWorkItemMergePolicy(input) ?? input.repositoryMergePolicy

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
