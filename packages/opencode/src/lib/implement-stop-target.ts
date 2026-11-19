import { createHash } from "node:crypto"
import { Effect } from "effect"
import {
  AgentBackendConfigError,
  type AgentBackendError,
  type AttachedImplementStop,
} from "@ready-for-agent/agent-backend"

export type StopCapture = (
  args: ReadonlyArray<string>,
) => Effect.Effect<{ readonly stdout: string }, AgentBackendError>

export const jsonRecord = (
  stdout: string,
): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(stdout)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const identifyImplementTarget = (input: {
  readonly sessionId: string
  readonly serverUrl: string
  readonly local: boolean
  readonly capture: StopCapture
}): Effect.Effect<AttachedImplementStop, AgentBackendError> =>
  Effect.gen(function* () {
    const { stdout } = yield* input.capture(["api", "get", "/api/info"])
    const pid = jsonRecord(stdout)?.pid
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      return yield* new AgentBackendConfigError({
        message: "OpenCode did not identify the server process for Implement.",
      })
    }
    return {
      sessionId: input.sessionId,
      serverKey: createHash("sha256")
        .update(JSON.stringify([input.serverUrl, pid]))
        .digest("hex"),
      ...(input.local ? { localPid: pid } : {}),
    }
  })

export const localImplementServerExited = (
  pid: number | undefined,
): boolean => {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return isRecord(error) && error.code === "ESRCH"
  }
}

export const verifyImplementIdle = (
  sessionId: string,
  capture: StopCapture,
): Effect.Effect<void, AgentBackendError> =>
  Effect.gen(function* () {
    const { stdout } = yield* capture(["api", "get", "/api/session/active"])
    const active = jsonRecord(stdout)?.data
    if (!isRecord(active) || Object.hasOwn(active, sessionId)) {
      return yield* new AgentBackendConfigError({
        message: `OpenCode did not confirm that session ${sessionId} is idle.`,
      })
    }
  })
