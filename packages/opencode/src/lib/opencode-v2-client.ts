import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import {
  OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
  classifyOpencodeReadError,
} from "./opencode-v2-compatibility.js"
import type { OpencodeV2Reader } from "./opencode-v2-read.js"

export type OpencodeExplicitServer = {
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
}

export type OpencodeServiceEndpoint = {
  readonly url: string
  readonly auth?: {
    readonly type: "basic"
    readonly username: string
    readonly password: string
  }
}

export type ConnectOpencodeV2Result =
  | {
      readonly kind: "ready"
      readonly reader: OpencodeV2Reader
    }
  | {
      readonly kind: "unavailable"
      readonly persistence: "transient" | "persistent"
      readonly diagnostic: string
    }

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const SERVICE_USERNAME = "opencode"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const opencodeServiceRegistrationPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const stateHome = env.XDG_STATE_HOME?.trim()
  const home = env.HOME?.trim()
  const root =
    stateHome !== undefined && stateHome.length > 0
      ? stateHome
      : join(
          home !== undefined && home.length > 0 ? home : homedir(),
          ".local",
          "state",
        )
  return join(root, "opencode", "service.json")
}

const readRegisteredEndpoint = (): OpencodeServiceEndpoint | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(opencodeServiceRegistrationPath(), "utf8"),
    )
    if (!isRecord(parsed) || typeof parsed["url"] !== "string") {
      return null
    }
    const password = parsed["password"]
    if (typeof password !== "string" || password.length === 0) {
      return { url: parsed["url"] }
    }
    return {
      url: parsed["url"],
      auth: { type: "basic", username: SERVICE_USERNAME, password },
    }
  } catch {
    return null
  }
}

const readerFromClient = (
  client: ReturnType<typeof OpenCode.make>,
  timeoutMs: number,
): OpencodeV2Reader => {
  const signal = () => AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs)))
  return {
    getServerInfo: () => client.server.info({ signal: signal() }),
    getSession: (sessionId) =>
      client.session.get({ sessionID: sessionId }, { signal: signal() }),
    listMessages: (input) =>
      client.message.list(
        {
          sessionID: input.sessionId,
          limit: input.limit,
          order: input.order,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
        { signal: signal() },
      ),
    listChildren: (input) =>
      client.session.list(
        {
          parentID: input.parentId,
          limit: input.limit,
          order: "desc",
        },
        { signal: signal() },
      ),
  }
}

const headersForEndpoint = (
  endpoint: OpencodeServiceEndpoint,
): Record<string, string> | undefined => {
  const headers = Service.headers(endpoint)
  return headers === undefined ? undefined : { ...headers }
}

const readyReader = (
  baseUrl: string,
  headers: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
): ConnectOpencodeV2Result => {
  const client = OpenCode.make({
    baseUrl,
    ...(headers === undefined ? {} : { headers }),
  })
  return { kind: "ready", reader: readerFromClient(client, timeoutMs) }
}

/**
 * Shared-service endpoint the telemetry client would use. Does not start the
 * service. Null when no registration can be read.
 */
export const discoverOpenCodeHandoffEndpoint = async (input?: {
  readonly discover?: (options?: {
    readonly version?: (version: string) => boolean
    readonly file?: string
  }) => Promise<OpencodeServiceEndpoint | undefined>
  readonly readRegistration?: () => OpencodeServiceEndpoint | null
  /** Isolated service.json. Production omits this and uses the process default. */
  readonly file?: string
}): Promise<{
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
} | null> => {
  const file = input?.file
  const discover =
    input?.discover ??
    ((options) =>
      Service.discover({
        ...options,
        ...(file === undefined ? {} : { file }),
      }))
  const readRegistration =
    input?.readRegistration ??
    (() => {
      if (file === undefined) return readRegisteredEndpoint()
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
        if (!isRecord(parsed) || typeof parsed["url"] !== "string") return null
        const password = parsed["password"]
        if (typeof password !== "string" || password.length === 0) {
          return { url: parsed["url"] }
        }
        return {
          url: parsed["url"],
          auth: { type: "basic", username: SERVICE_USERNAME, password },
        }
      } catch {
        return null
      }
    })
  try {
    const discovered = await discover()
    if (discovered !== undefined) {
      const headers = headersForEndpoint(discovered)
      return {
        baseUrl: discovered.url,
        ...(headers === undefined ? {} : { headers }),
      }
    }
  } catch {
    // Fall through to the registration file. Do not start the service.
  }
  const registered = readRegistration()
  if (registered === null) return null
  const headers = headersForEndpoint(registered)
  return {
    baseUrl: registered.url,
    ...(headers === undefined ? {} : { headers }),
  }
}

/**
 * Select the same endpoint agent execution would use and return a reader.
 * Does not probe server version or treat a missed lookup as incompatibility.
 * A version string is not an API contract.
 */
export const connectOpencodeV2 = async (input: {
  readonly server?: OpencodeExplicitServer
  readonly requestTimeoutMs?: number
  readonly discover?: (options?: {
    readonly version?: (version: string) => boolean
  }) => Promise<OpencodeServiceEndpoint | undefined>
  readonly readRegistration?: () => OpencodeServiceEndpoint | null
}): Promise<ConnectOpencodeV2Result> => {
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const discover = input.discover ?? Service.discover
  const readRegistration = input.readRegistration ?? readRegisteredEndpoint
  const explicit = input.server
  if (explicit !== undefined && explicit.baseUrl.trim().length > 0) {
    return readyReader(explicit.baseUrl, explicit.headers, timeoutMs)
  }

  try {
    // No version predicate. A missed lookup is not a compatibility failure.
    const discovered = await discover()
    if (discovered !== undefined) {
      return readyReader(
        discovered.url,
        headersForEndpoint(discovered),
        timeoutMs,
      )
    }
  } catch (error) {
    const failure = classifyOpencodeReadError(error)
    if (failure.kind === "unavailable") {
      return failure
    }
  }

  const registered = readRegistration()
  if (registered === null) {
    return {
      kind: "unavailable",
      persistence: "transient",
      diagnostic: OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
    }
  }
  return readyReader(registered.url, headersForEndpoint(registered), timeoutMs)
}
