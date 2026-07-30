import { Effect } from "effect"
import {
  type WorkItemState,
  isDeclaredLifecycleTransition,
} from "@ready-for-agent/lifecycle-model"

export type TransitionRelationCheckMode = "observe" | "strict"

export class UndeclaredLifecycleTransitionError extends Error {
  readonly from: WorkItemState
  readonly to: WorkItemState

  constructor(from: WorkItemState, to: WorkItemState) {
    super(`Undeclared lifecycle transition: ${from} -> ${to}`)
    this.name = "UndeclaredLifecycleTransitionError"
    this.from = from
    this.to = to
  }
}

export const transitionRelationCheckMode = (
  nodeEnv: string | undefined = process.env["NODE_ENV"],
): TransitionRelationCheckMode => (nodeEnv === "test" ? "strict" : "observe")

/**
 * Runtime boundary for every applied Work Item state transition.
 *
 * Production observes ontology drift without changing lifecycle behavior.
 * Tests treat the same violation as an invariant defect so the lifecycle suite
 * proves that every exercised pair is declared.
 */
export const checkAppliedLifecycleTransition = (
  from: WorkItemState,
  to: WorkItemState,
  mode: TransitionRelationCheckMode = transitionRelationCheckMode(),
): Effect.Effect<void> => {
  if (isDeclaredLifecycleTransition(from, to)) {
    return Effect.void
  }

  const error = new UndeclaredLifecycleTransitionError(from, to)
  if (mode === "strict") {
    return Effect.die(error)
  }

  return Effect.logWarning("Applied lifecycle transition is not declared", {
    event: "undeclared_lifecycle_transition",
    fromStep: from,
    toStep: to,
  })
}

export const applyCheckedLifecycleTransition = <A, E, R, StateE, StateR>(
  readCurrentState: Effect.Effect<WorkItemState | undefined, StateE, StateR>,
  to: WorkItemState,
  mutation: Effect.Effect<A, E, R>,
  didApply: (result: A) => boolean,
  mode: TransitionRelationCheckMode = transitionRelationCheckMode(),
): Effect.Effect<A, E | StateE, R | StateR> =>
  Effect.gen(function* () {
    const from = yield* readCurrentState
    const result = yield* mutation
    const current = yield* readCurrentState
    if (from !== undefined && didApply(result) && current === to) {
      yield* checkAppliedLifecycleTransition(from, to, mode)
    }
    return result
  })
