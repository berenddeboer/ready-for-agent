import { Effect } from "effect"
import type { LifecycleStepCompletion } from "./types.js"

/**
 * Outcome of a native attempt: either it reported success, or it reported
 * failure with bounded diagnostics. Callers must not treat `ok: true` as the
 * step's postcondition — the postcondition is always re-checked independently
 * via `checkAfterNative`.
 */
export type NativeAttemptOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: string }

export type RepairFallbackOutcome<V> = {
  readonly completion: LifecycleStepCompletion
  readonly value: V
}

/**
 * Configuration for one Repair Fallback pass. `V` is the step's own
 * postcondition-derived value (for example a resolved publication copy, or an
 * open pull request number); `Prepared` is whatever a step needs resolved
 * before the repair Agent Turn can run (for example a Session ID, optionally
 * combined with Forge credential guidance).
 *
 * Every check and diagnostic-collection effect is supplied by the calling
 * Lifecycle Step: Repair Fallback only orchestrates the sequence, it never
 * inspects git, a Forge API, or an Agent Turn result itself.
 */
export interface RepairFallbackConfig<V, Prepared, E, R> {
  /**
   * Retry-safety / idempotency check: does the postcondition already hold
   * before any native mutation is attempted? Returns the step's value when it
   * does, `null` otherwise. Run once, before `attemptNative`.
   */
  readonly checkAlreadySatisfied: Effect.Effect<V | null, E, R>
  /** Attempt the step's native (non-agent) action. */
  readonly attemptNative: Effect.Effect<NativeAttemptOutcome, E, R>
  /**
   * Independent re-check of the postcondition after the native attempt.
   * Always run, regardless of what `attemptNative` itself reported — a
   * native call that reports success is not trusted on its own.
   */
  readonly checkAfterNative: (
    native: NativeAttemptOutcome,
  ) => Effect.Effect<V | null, E, R>
  /** Diagnostics to include in the repair prompt when native did not establish the postcondition. */
  readonly buildDiagnosticsAfterNative: (
    native: NativeAttemptOutcome,
  ) => Effect.Effect<string, E, R>
  /**
   * Step-specific work required before the repair Agent Turn can run (for
   * example resolving a Session ID, or resolving Forge credentials for the
   * Agent Turn). Committing code has none beyond a Session ID; creating a
   * pull request additionally resolves Forge credential guidance.
   */
  readonly prepareAgentFallback: Effect.Effect<Prepared, E, R>
  /** Ask the agent to finish the step. Runs at most once per Repair Fallback pass. */
  readonly askAgentToFinish: (
    diagnostics: string,
    prepared: Prepared,
  ) => Effect.Effect<void, E, R>
  /**
   * Independent re-check of the postcondition after the repair Agent Turn.
   * Never trusts the Agent Turn's own report — only this check decides
   * whether the fallback succeeded.
   */
  readonly checkAfterFallback: Effect.Effect<V | null, E, R>
  /** Diagnostics for the persistent-failure error, given the pre-fallback diagnostics. */
  readonly buildDiagnosticsAfterFallback: (
    diagnosticsAfterNative: string,
  ) => Effect.Effect<string, E, R>
  /** Build the step's own error when the postcondition remains unmet after native and fallback. */
  readonly onPersistentFailure: (
    diagnostics: string,
  ) => Effect.Effect<never, E, R>
}

/**
 * Repair Fallback: the shared recovery behavior used by Lifecycle Steps that
 * harness-own a native mutation but may need one bounded Agent Turn to finish
 * the step. Attempts the native action; if the step's postcondition already
 * holds (either before the attempt, or independently confirmed afterward),
 * the step completes natively. Otherwise it continues the Work Item's Agent
 * Session for exactly one Agent Turn asking the agent to finish the step,
 * then independently re-checks the postcondition — the Agent Turn's own
 * report is never trusted. Commit and Create PR are its two current callers;
 * see ADR-0011 and ADR-0012.
 */
export const repairFallback = <V, Prepared, E, R>(
  config: RepairFallbackConfig<V, Prepared, E, R>,
): Effect.Effect<RepairFallbackOutcome<V>, E, R> =>
  Effect.gen(function* () {
    const alreadySatisfied = yield* config.checkAlreadySatisfied
    if (alreadySatisfied !== null) {
      return { completion: "native", value: alreadySatisfied }
    }

    const native = yield* config.attemptNative

    const afterNative = yield* config.checkAfterNative(native)
    if (afterNative !== null) {
      return { completion: "native", value: afterNative }
    }

    const diagnosticsAfterNative =
      yield* config.buildDiagnosticsAfterNative(native)
    const prepared = yield* config.prepareAgentFallback
    yield* config.askAgentToFinish(diagnosticsAfterNative, prepared)

    const afterFallback = yield* config.checkAfterFallback
    if (afterFallback !== null) {
      return { completion: "agent_fallback", value: afterFallback }
    }

    const finalDiagnostics = yield* config.buildDiagnosticsAfterFallback(
      diagnosticsAfterNative,
    )
    return yield* config.onPersistentFailure(finalDiagnostics)
  })
