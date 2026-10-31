import { CI_GATE_DISABLED_LABEL } from "./ci-gate-status-label.js"
import type { CiGateStoryInput } from "./ci-gate-status-story.js"
import { CiGateStatusStory } from "./ci-gate-status-story-view.js"

export function RepositoryCiGateCardDetails({
  ciGate,
  canStartCiRepair,
  repairPending = false,
  onStartRepair,
  nowMs,
}: {
  readonly ciGate: CiGateStoryInput
  /**
   * Server predicate: gate Closed and no unfinished CI Repair Work Item.
   * Do not also require automatic CI repair, Paused, or an active incident.
   * An unfinished repair hides this action even if the predicate is stale.
   */
  readonly canStartCiRepair?: boolean
  readonly repairPending?: boolean
  readonly onStartRepair?: () => void
  readonly nowMs?: number
}) {
  if (ciGate.status === "DISABLED") {
    return CI_GATE_DISABLED_LABEL
  }
  return (
    <CiGateStatusStory
      ciGate={{
        ...ciGate,
        canStartCiRepair: canStartCiRepair ?? ciGate.canStartCiRepair,
      }}
      nowMs={nowMs}
      repairPending={repairPending}
      onStartRepair={onStartRepair}
    />
  )
}
