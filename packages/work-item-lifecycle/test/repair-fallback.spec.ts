import { Effect } from "effect"
import { repairFallback } from "../src/lib/repair-fallback.js"
import { describe, expect, it } from "bun:test"

/** Marker error so persistent-failure assertions do not rely on stringly-typed messages. */
class FakePersistentFailureError {
  readonly _tag = "FakePersistentFailureError"
  constructor(readonly diagnostics: string) {}
}

/**
 * Fake native+agent state: `satisfied` models the postcondition truth
 * (independent of what native or the agent report), so `checkAfterNative`/
 * `checkAfterFallback` can assert the postcondition is re-derived rather
 * than trusted from a native or agent report.
 */
const makeFakeState = (initiallySatisfied: boolean) => ({
  satisfied: initiallySatisfied,
  value: "resolved-value",
})

describe("repairFallback", () => {
  it("completes natively without an Agent Turn when already satisfied", async () => {
    let attemptNativeCalls = 0
    let askAgentCalls = 0

    const outcome = await Effect.runPromise(
      repairFallback({
        checkAlreadySatisfied: Effect.succeed("already-there"),
        attemptNative: Effect.sync(() => {
          attemptNativeCalls += 1
          return { ok: true as const }
        }),
        checkAfterNative: () => Effect.succeed("unused"),
        buildDiagnosticsAfterNative: () => Effect.succeed("unused"),
        prepareAgentFallback: Effect.succeed(undefined),
        askAgentToFinish: () =>
          Effect.sync(() => {
            askAgentCalls += 1
          }),
        checkAfterFallback: Effect.succeed("unused"),
        buildDiagnosticsAfterFallback: (diagnostics) =>
          Effect.succeed(diagnostics),
        onPersistentFailure: (diagnostics) =>
          Effect.fail(new FakePersistentFailureError(diagnostics)),
      }),
    )

    expect(outcome).toEqual({ completion: "native", value: "already-there" })
    expect(attemptNativeCalls).toBe(0)
    expect(askAgentCalls).toBe(0)
  })

  it("completes natively when the native attempt independently establishes the postcondition", async () => {
    const state = makeFakeState(false)
    let askAgentCalls = 0

    const outcome = await Effect.runPromise(
      repairFallback({
        checkAlreadySatisfied: Effect.succeed(null),
        attemptNative: Effect.sync(() => {
          state.satisfied = true
          return { ok: true as const }
        }),
        checkAfterNative: () =>
          Effect.sync(() => (state.satisfied ? state.value : null)),
        buildDiagnosticsAfterNative: () => Effect.succeed("unused"),
        prepareAgentFallback: Effect.succeed(undefined),
        askAgentToFinish: () =>
          Effect.sync(() => {
            askAgentCalls += 1
          }),
        checkAfterFallback: Effect.succeed(null),
        buildDiagnosticsAfterFallback: (diagnostics) =>
          Effect.succeed(diagnostics),
        onPersistentFailure: (diagnostics) =>
          Effect.fail(new FakePersistentFailureError(diagnostics)),
      }),
    )

    expect(outcome).toEqual({ completion: "native", value: state.value })
    expect(askAgentCalls).toBe(0)
  })

  it("falls back to a bounded Agent Turn and re-checks independently when native fails", async () => {
    const state = makeFakeState(false)
    let askAgentCalls = 0
    let receivedDiagnostics: string | null = null
    let receivedPrepared: string | null = null

    const outcome = await Effect.runPromise(
      repairFallback({
        checkAlreadySatisfied: Effect.succeed(null),
        attemptNative: Effect.succeed({
          ok: false as const,
          diagnostics: "native push failed: no route to host",
        }),
        checkAfterNative: () =>
          Effect.sync(() => (state.satisfied ? state.value : null)),
        buildDiagnosticsAfterNative: (native) =>
          Effect.succeed(
            native.ok ? "unreachable" : `native: ${native.diagnostics}`,
          ),
        prepareAgentFallback: Effect.succeed("prepared-context"),
        askAgentToFinish: (diagnostics, prepared) =>
          Effect.sync(() => {
            askAgentCalls += 1
            receivedDiagnostics = diagnostics
            receivedPrepared = prepared
            // The agent's own turn "succeeds" (no thrown error) *and* it
            // actually repairs the underlying problem this time.
            state.satisfied = true
          }),
        checkAfterFallback: Effect.sync(() =>
          state.satisfied ? state.value : null,
        ),
        buildDiagnosticsAfterFallback: (diagnostics) =>
          Effect.succeed(diagnostics),
        onPersistentFailure: (diagnostics) =>
          Effect.fail(new FakePersistentFailureError(diagnostics)),
      }),
    )

    expect(outcome).toEqual({
      completion: "agent_fallback",
      value: state.value,
    })
    expect(askAgentCalls).toBe(1)
    expect(receivedDiagnostics).toBe(
      "native: native push failed: no route to host",
    )
    expect(receivedPrepared).toBe("prepared-context")
  })

  it("never trusts the Agent Turn's own report: a successful turn that left the postcondition unmet still fails", async () => {
    const state = makeFakeState(false)
    let onPersistentFailureCalls = 0
    let receivedDiagnostics: string | null = null

    const failure = await Effect.runPromise(
      repairFallback({
        checkAlreadySatisfied: Effect.succeed(null),
        attemptNative: Effect.succeed({
          ok: false as const,
          diagnostics: "native commit failed",
        }),
        checkAfterNative: () =>
          Effect.sync(() => (state.satisfied ? state.value : null)),
        buildDiagnosticsAfterNative: (native) =>
          Effect.succeed(
            native.ok ? "unreachable" : `native: ${native.diagnostics}`,
          ),
        prepareAgentFallback: Effect.succeed(undefined),
        // The Agent Turn itself reports success (no thrown error), but it
        // did not actually fix anything — `state.satisfied` stays false.
        askAgentToFinish: () => Effect.succeed(undefined),
        checkAfterFallback: Effect.sync(() =>
          state.satisfied ? state.value : null,
        ),
        buildDiagnosticsAfterFallback: (diagnostics) =>
          Effect.sync(() => {
            onPersistentFailureCalls += 1
            receivedDiagnostics = diagnostics
            return diagnostics
          }),
        onPersistentFailure: (diagnostics) =>
          Effect.fail(new FakePersistentFailureError(diagnostics)),
      }).pipe(Effect.flip),
    )

    expect(onPersistentFailureCalls).toBe(1)
    expect(receivedDiagnostics).toBe("native: native commit failed")
    expect(failure).toBeInstanceOf(FakePersistentFailureError)
    expect(failure.diagnostics).toBe("native: native commit failed")
  })

  it("fails via onPersistentFailure when both native and Agent Turn fallback leave the postcondition unmet", async () => {
    let askAgentCalls = 0

    const failure = await Effect.runPromise(
      repairFallback({
        checkAlreadySatisfied: Effect.succeed(null),
        attemptNative: Effect.succeed({
          ok: false as const,
          diagnostics: "native failed",
        }),
        checkAfterNative: () => Effect.succeed(null),
        buildDiagnosticsAfterNative: (native) =>
          Effect.succeed(native.ok ? "unreachable" : native.diagnostics),
        prepareAgentFallback: Effect.succeed(undefined),
        askAgentToFinish: () =>
          Effect.sync(() => {
            askAgentCalls += 1
          }),
        checkAfterFallback: Effect.succeed(null),
        buildDiagnosticsAfterFallback: (diagnostics) =>
          Effect.succeed(`still unmet: ${diagnostics}`),
        onPersistentFailure: (diagnostics) =>
          Effect.fail(new FakePersistentFailureError(diagnostics)),
      }).pipe(Effect.flip),
    )

    expect(askAgentCalls).toBe(1)
    expect(failure).toBeInstanceOf(FakePersistentFailureError)
    expect(failure.diagnostics).toBe("still unmet: native failed")
  })
})
