import { Duration, Effect } from "effect"
import {
  type ConnectOpencodeV2Result,
  type OpencodeExplicitServer,
  connectOpencodeV2,
} from "./opencode-v2-client.js"
import {
  type OpencodeV2Reader,
  probeStartupActivity,
} from "./opencode-v2-read.js"

/** Fast enough to disarm within a short startup window (default 90s; tests use ~200ms). */
const DEFAULT_POLL_INTERVAL = Duration.millis(100)
const STARTUP_PROBE_TIMEOUT_MS = 800

export type OpencodeStartupProbe = (input: {
  readonly sessionId: string
  readonly startedAfterMs: number
}) => boolean | Promise<boolean>

/**
 * True when the V2 API shows a child session or a parent task/subtask created
 * at or after `startedAfterMs`. Probe errors are not activity.
 */
export const hasOpencodeTaskSubagentActivity = async (input: {
  readonly reader: OpencodeV2Reader
  readonly sessionId: string
  readonly startedAfterMs: number
}): Promise<boolean> => {
  try {
    return await probeStartupActivity(
      input.reader,
      input.sessionId,
      input.startedAfterMs,
    )
  } catch {
    return false
  }
}

export type ObserveOpencodeStartupActivityInput = {
  readonly sessionId: string
  /** Only count activity at or after this epoch ms (just before CLI spawn). */
  readonly startedAfterMs: number
  readonly pollInterval?: Duration.Input
  readonly probe: OpencodeStartupProbe
}

/**
 * Succeeds when OpenCode shows the turn has begun for `sessionId`. Polls until
 * then; never fails (callers ignore probe errors). Interrupted when the
 * runCliTurn scope ends.
 */
export const observeOpencodeStartupActivity = (
  input: ObserveOpencodeStartupActivityInput,
): Effect.Effect<void> => {
  const pollInterval = input.pollInterval ?? DEFAULT_POLL_INTERVAL
  return Effect.gen(function* () {
    for (;;) {
      const active = yield* Effect.promise(() =>
        Promise.resolve(
          input.probe({
            sessionId: input.sessionId,
            startedAfterMs: input.startedAfterMs,
          }),
        ),
      ).pipe(Effect.orElseSucceed(() => false))
      if (active) {
        return
      }
      yield* Effect.sleep(pollInterval)
    }
  })
}

export const makeOpencodeStartupProbe = (input: {
  readonly server?: OpencodeExplicitServer
  readonly resolveReader: () => Promise<OpencodeV2Reader | null>
}): OpencodeStartupProbe => {
  return async ({ sessionId, startedAfterMs }) => {
    const reader = await input.resolveReader()
    if (reader === null) {
      return false
    }
    return hasOpencodeTaskSubagentActivity({
      reader,
      sessionId,
      startedAfterMs,
    })
  }
}

export const connectStartupReader = async (input: {
  readonly server?: OpencodeExplicitServer
}): Promise<OpencodeV2Reader | null> => {
  let connected: ConnectOpencodeV2Result
  try {
    connected = await connectOpencodeV2({
      ...(input.server === undefined ? {} : { server: input.server }),
      requestTimeoutMs: STARTUP_PROBE_TIMEOUT_MS,
    })
  } catch {
    return null
  }
  return connected.kind === "ready" ? connected.reader : null
}
