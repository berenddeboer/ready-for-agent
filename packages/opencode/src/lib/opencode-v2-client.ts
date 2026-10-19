import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import {
  OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC,
  OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
  classifyOpencodeReadError,
  isSupportedOpenCodeServerVersion,
  openCodeV2IncompatibleDiagnostic,
  persistentFailure,
  transientFailure,
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
      readonly version: string
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

export const opencodeServiceRegistrationPath = (
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

const versionFromInfo = (raw: unknown): string | undefined => {
  if (!isRecord(raw) || typeof raw["version"] !== "string") {
    return undefined
  }
  const version = raw["version"].trim()
  return version.length > 0 ? version : undefined
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

const classifyInfo = (
  raw: unknown,
):
  | { readonly kind: "supported"; readonly version: string }
  | ConnectOpencodeV2Result => {
  const version = versionFromInfo(raw)
  if (version === undefined) {
    return {
      kind: "unavailable",
      persistence: "persistent",
      diagnostic: openCodeV2IncompatibleDiagnostic("unknown"),
    }
  }
  if (!isSupportedOpenCodeServerVersion(version)) {
    return {
      kind: "unavailable",
      persistence: "persistent",
      diagnostic: openCodeV2IncompatibleDiagnostic(version),
    }
  }
  return { kind: "supported", version }
}

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
    const client = OpenCode.make({
      baseUrl: explicit.baseUrl,
      ...(explicit.headers === undefined ? {} : { headers: explicit.headers }),
    })
    const reader = readerFromClient(client, timeoutMs)
    try {
      const info = await reader.getServerInfo()
      const classified = classifyInfo(info)
      if (classified.kind !== "supported") {
        return classified
      }
      return { kind: "ready", reader, version: classified.version }
    } catch (error) {
      const failure = classifyOpencodeReadError(error)
      if (failure.kind === "missing") {
        return transientFailure()
      }
      return failure
    }
  }

  try {
    const compatible = await discover({
      version: isSupportedOpenCodeServerVersion,
    })
    if (compatible !== undefined) {
      const client = OpenCode.make({
        baseUrl: compatible.url,
        headers: headersForEndpoint(compatible),
      })
      const reader = readerFromClient(client, timeoutMs)
      const info = await reader.getServerInfo()
      const classified = classifyInfo(info)
      if (classified.kind !== "supported") {
        return classified
      }
      return { kind: "ready", reader, version: classified.version }
    }
    const any = await discover()
    if (any !== undefined) {
      const client = OpenCode.make({
        baseUrl: any.url,
        headers: headersForEndpoint(any),
      })
      const reader = readerFromClient(client, timeoutMs)
      try {
        const info = await reader.getServerInfo()
        const version = versionFromInfo(info) ?? "unknown"
        return {
          kind: "unavailable",
          persistence: "persistent",
          diagnostic: openCodeV2IncompatibleDiagnostic(version),
        }
      } catch (error) {
        const failure = classifyOpencodeReadError(error)
        if (failure.kind === "missing") {
          return persistentFailure(openCodeV2IncompatibleDiagnostic("unknown"))
        }
        return failure
      }
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
  try {
    const client = OpenCode.make({
      baseUrl: registered.url,
      headers: headersForEndpoint(registered),
    })
    const reader = readerFromClient(client, timeoutMs)
    const info = await reader.getServerInfo()
    const classified = classifyInfo(info)
    if (classified.kind !== "supported") {
      return classified
    }
    return { kind: "ready", reader, version: classified.version }
  } catch (error) {
    const failure = classifyOpencodeReadError(error)
    if (failure.kind === "missing") {
      return persistentFailure(OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC)
    }
    return failure
  }
}

export { persistentFailure, transientFailure }
