import type { ReactNode } from "react"
import { formatVariantLabel } from "./agent-model-settings.js"
import { cx, ui } from "./ui.js"

export type WorkItemExecutionProfileView = {
  readonly backend: { readonly id: string; readonly label: string }
  readonly buildModel: string
  readonly buildThinkingLevel: string | null
  readonly reviewSameAsBuild: boolean
  readonly reviewModel: string
  readonly reviewThinkingLevel: string | null
}

const selectionLabel = (input: {
  readonly model: string
  readonly thinkingLevel: string | null
}): string => {
  if (input.thinkingLevel === null || input.thinkingLevel === "") {
    return input.model
  }
  return `${input.model} · ${formatVariantLabel(input.thinkingLevel)}`
}

/**
 * Operator-facing Explicit Work Item Execution Profile chrome for Work Item
 * detail and history. Hidden when the Work Item is settings-resolved.
 */
export function ExecutionProfileSummary({
  profile,
  className,
}: {
  readonly profile: WorkItemExecutionProfileView | null | undefined
  readonly className?: string
}): ReactNode {
  if (profile === null || profile === undefined) {
    return null
  }
  const reviewLabel = profile.reviewSameAsBuild
    ? "Same as build"
    : selectionLabel({
        model: profile.reviewModel,
        thinkingLevel: profile.reviewThinkingLevel,
      })
  return (
    <div className={cx("min-w-0 max-w-full", className)} data-execution-profile>
      <p className={ui.jobTicketRuntimeLine}>
        Explicit Work Item Execution Profile
      </p>
      <p className={ui.jobTicketRuntimeLine}>{profile.backend.label}</p>
      <p className={ui.jobTicketRuntimeLine}>
        Build{" "}
        {selectionLabel({
          model: profile.buildModel,
          thinkingLevel: profile.buildThinkingLevel,
        })}
      </p>
      <p className={ui.jobTicketRuntimeLine}>Review {reviewLabel}</p>
    </div>
  )
}
