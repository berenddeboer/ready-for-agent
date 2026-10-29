import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ulid } from "ulidx"
import { isAgentDependentLifecycleStep } from "@ready-for-agent/lifecycle-model"
import { WorkItemLifecycleDatabaseError } from "./errors.js"

type ExecutionModelRole = "build" | "review"

/** Model selected for one role of one agent execution. Thinking level is omitted. */
export type SelectedExecutionModel = {
  readonly role: ExecutionModelRole
  readonly model: string
}

const nonEmpty = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Models this execution will use. Review selects both roles. Every other
 * agent execution selects the build model only, so a review model resolved
 * alongside it is not recorded. Agent-free steps record nothing.
 */
export const modelsSelectedForExecution = (
  step: string,
  selection: {
    readonly model: string
    readonly reviewModel: string
  },
): readonly SelectedExecutionModel[] => {
  if (!isAgentDependentLifecycleStep(step)) {
    return []
  }
  const build = nonEmpty(selection.model)
  if (step !== "review") {
    return build === null ? [] : [{ role: "build", model: build }]
  }
  const review = nonEmpty(selection.reviewModel)
  const selected: SelectedExecutionModel[] = []
  if (review !== null) {
    selected.push({ role: "review", model: review })
  }
  if (build !== null) {
    selected.push({ role: "build", model: build })
  }
  return selected
}

/**
 * Persist the models admitted for this Step Run. Insert-or-ignore keeps a
 * later settings change from rewriting history if the same run is seen again.
 * Call only on the fresh start path, after catalog admission, never on
 * recovery of an already-running Step Run.
 */
export const recordStepRunAgentModels = Effect.fn("recordStepRunAgentModels")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly stepRunId: string
      readonly step: string
      readonly selection: {
        readonly model: string
        readonly reviewModel: string
      }
      readonly nowMs: number
    },
  ) {
    for (const selected of modelsSelectedForExecution(
      input.step,
      input.selection,
    )) {
      yield* sql
        .unsafe(
          `INSERT OR IGNORE INTO step_run_agent_model (
             id, step_run_id, role, model, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            `sram-${ulid()}`,
            input.stepRunId,
            selected.role,
            selected.model,
            input.nowMs,
          ],
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkItemLifecycleDatabaseError({
                message: `Could not record Agent Model provenance for Step Run ${input.stepRunId}`,
                cause,
              }),
          ),
        )
    }
  },
)
