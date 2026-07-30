import { Cause, Effect, Exit, Result } from "effect"
import {
  LIFECYCLE_TRANSITIONS,
  type WorkItemState,
} from "@ready-for-agent/lifecycle-model"
import {
  UndeclaredLifecycleTransitionError,
  applyCheckedLifecycleTransition,
  checkAppliedLifecycleTransition,
  transitionRelationCheckMode,
} from "../src/lib/transition-relation-check.js"
import { STEP_RUN_REASON, type StepRunReasonCode } from "../src/lib/types.js"
import { describe, expect, it } from "bun:test"

describe("lifecycle transition relation check", () => {
  it("uses strict mode only under test", () => {
    expect(transitionRelationCheckMode()).toBe("strict")
    expect(transitionRelationCheckMode("test")).toBe("strict")
    expect(transitionRelationCheckMode("production")).toBe("observe")
    expect(transitionRelationCheckMode("development")).toBe("observe")
  })

  it("draws every declared transition reason from STEP_RUN_REASON", () => {
    const reasonCodes = new Set<StepRunReasonCode>(
      Object.values(STEP_RUN_REASON),
    )

    for (const transition of LIFECYCLE_TRANSITIONS) {
      expect(reasonCodes.has(transition.reasonCode)).toBe(true)
    }
  })

  it("observes an undeclared production pair without failing", () => {
    const exit = Effect.runSyncExit(
      checkAppliedLifecycleTransition("create_worktree", "complete", "observe"),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails strict mode for a deliberately undeclared transition", () => {
    const exit = Effect.runSyncExit(
      checkAppliedLifecycleTransition("create_worktree", "complete", "strict"),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defect = Cause.findDefect(exit.cause)
      expect(Result.isSuccess(defect)).toBe(true)
      if (Result.isSuccess(defect)) {
        expect(defect.success).toBeInstanceOf(
          UndeclaredLifecycleTransitionError,
        )
      }
    }
  })

  it("does not check an attempted transition when its mutation is a no-op", () => {
    const state = Effect.succeed("local_cleanup" as const)
    const exit = Effect.runSyncExit(
      applyCheckedLifecycleTransition(
        state,
        "local_cleanup",
        Effect.void,
        () => false,
        "strict",
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("checks an undeclared transition after its mutation reaches the target", () => {
    const state: { value: WorkItemState } = { value: "create_worktree" }
    const readState = Effect.sync(() => state.value)
    const exit = Effect.runSyncExit(
      applyCheckedLifecycleTransition(
        readState,
        "complete",
        Effect.sync(() => {
          state.value = "complete"
        }),
        () => true,
        "strict",
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defect = Cause.findDefect(exit.cause)
      expect(Result.isSuccess(defect)).toBe(true)
      if (Result.isSuccess(defect)) {
        expect(defect.success).toBeInstanceOf(
          UndeclaredLifecycleTransitionError,
        )
      }
    }
  })
})
