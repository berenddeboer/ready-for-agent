import { Context, Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  type AgentTurnTail,
  makeAgentTurnTail,
  unavailableAgentTurnTail,
} from "@ready-for-agent/agent-backend"
import {
  type ConnectOpencodeV2Result,
  type OpencodeExplicitServer,
  connectOpencodeV2,
} from "./opencode-v2-client.js"
import { OPENCODE_V2_TRANSIENT_DIAGNOSTIC } from "./opencode-v2-compatibility.js"
import {
  type OpencodeV2Reader,
  readSession,
  readTail,
} from "./opencode-v2-read.js"

export type SessionAvailability = "available" | "missing" | "unavailable"

export type SessionModel = {
  readonly providerId: string
  readonly id: string
  readonly variant: string | null
}

export type SessionTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type OpencodeSession = {
  readonly id: string
  readonly availability: SessionAvailability
  readonly diagnostic: string | null
  readonly model: SessionModel | null
  readonly tokens: SessionTokens | null
  readonly cost: number | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

const OPENCODE_BACKEND = {
  id: AGENT_BACKEND_IDS.opencode,
  label: "OpenCode",
} as const

export type OpencodeSessionStoreShape = {
  readonly getSession: (id: string) => Effect.Effect<OpencodeSession, never>
  readonly getTail: (id: string) => Effect.Effect<AgentTurnTail, never>
}

export class OpencodeSessionStore extends Context.Service<
  OpencodeSessionStore,
  OpencodeSessionStoreShape
>()("@ready-for-agent/opencode/OpencodeSessionStore") {}

const unavailable = (id: string, diagnostic: string): OpencodeSession => ({
  id,
  availability: "unavailable",
  diagnostic,
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

export type OpencodeSessionStoreOptions = {
  /** Test seam. Production discovers the local service or uses `server`. */
  readonly reader?: OpencodeV2Reader
  readonly server?: OpencodeExplicitServer
  readonly requestTimeoutMs?: number
  readonly connect?: () => Promise<ConnectOpencodeV2Result>
}

export const makeOpencodeSessionStore = (
  shape: OpencodeSessionStoreShape,
): OpencodeSessionStoreShape => shape

export const OpencodeSessionStoreLive = (
  options: OpencodeSessionStoreOptions = {},
): Layer.Layer<OpencodeSessionStore> => {
  // Discover on every read. A ready client must not be pinned: OpenCode
  // restarts on a new address, and Retry has to find that service.
  const connect = async (): Promise<ConnectOpencodeV2Result> => {
    if (options.reader !== undefined) {
      return { kind: "ready", reader: options.reader }
    }
    if (options.connect !== undefined) {
      return options.connect()
    }
    return connectOpencodeV2({
      ...(options.server === undefined ? {} : { server: options.server }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    })
  }

  const readConnected = async <A>(
    onReady: (
      reader: ConnectOpencodeV2Result & { kind: "ready" },
    ) => Promise<A>,
    onUnavailable: (diagnostic: string) => A,
    onThrown: () => A,
  ): Promise<A> => {
    try {
      const connected = await connect()
      if (connected.kind !== "ready") {
        return onUnavailable(connected.diagnostic)
      }
      return await onReady(connected)
    } catch {
      return onThrown()
    }
  }

  return Layer.succeed(
    OpencodeSessionStore,
    makeOpencodeSessionStore({
      getSession: (id) =>
        Effect.promise(() =>
          readConnected(
            (connected) => readSession(connected.reader, id),
            (diagnostic) => unavailable(id, diagnostic),
            () => unavailable(id, OPENCODE_V2_TRANSIENT_DIAGNOSTIC),
          ),
        ),
      getTail: (id) =>
        Effect.promise(() =>
          readConnected(
            (connected) => readTail(connected.reader, id),
            (diagnostic) =>
              makeAgentTurnTail({
                availability: "unavailable",
                backend: OPENCODE_BACKEND,
                items: [],
                diagnostic,
              }),
            () => unavailableAgentTurnTail(OPENCODE_BACKEND),
          ),
        ),
    }),
  )
}
