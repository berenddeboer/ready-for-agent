import { createHash } from "node:crypto"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import {
  AgentBackendConfigError,
  type AgentBackendError,
  type AttachedImplementStop,
} from "@ready-for-agent/agent-backend"
import {
  OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
  type OwnedOpenCodeServer,
} from "./owned-server.js"

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

type OwnedIdentityEndpoint = Pick<
  OwnedOpenCodeServer,
  "baseUrl" | "headers" | "pid"
>

const fetchWithoutRedirects = Object.assign(
  (...[url, init]: Parameters<typeof fetch>) =>
    fetch(url, { ...init, redirect: "error" }),
  { preconnect: fetch.preconnect },
)

const readOwnedImplementServerInfo = (server: OwnedIdentityEndpoint) =>
  Effect.tryPromise({
    try: (signal) =>
      OpenCode.make({
        baseUrl: server.baseUrl,
        headers: server.headers,
        fetch: fetchWithoutRedirects,
      }).server.info({
        signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      }),
    // Do not forward client errors: they can include raw request/response data.
    catch: () =>
      new AgentBackendConfigError({
        message: OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
      }),
  })

export const identifyImplementTarget = (input: {
  readonly sessionId: string
  readonly serverUrl: string
  readonly local: boolean
  readonly capture: StopCapture
  readonly ownedServer: OwnedIdentityEndpoint | undefined
}): Effect.Effect<AttachedImplementStop, AgentBackendError> =>
  Effect.gen(function* () {
    const owned = input.ownedServer
    const info: unknown =
      owned === undefined
        ? jsonRecord((yield* input.capture(["api", "get", "/api/info"])).stdout)
        : yield* readOwnedImplementServerInfo(owned)
    const pid = isRecord(info) ? info.pid : undefined
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      return yield* new AgentBackendConfigError({
        message: "OpenCode did not identify the server process for Implement.",
      })
    }
    if (owned !== undefined && pid !== owned.pid) {
      return yield* new AgentBackendConfigError({
        message:
          "The owned OpenCode endpoint belongs to a different server process.",
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
