/**
 * Operator-triggered OpenCode session handoff.
 *
 * Verified on OpenCode 2.0.32: `POST /api/pair` returns a single-use code.
 * `GET /auth/connect/{code}` with `Accept: text/html` sets an HttpOnly cookie
 * and redirects to `/`, not the Session. The browser must then open the
 * Session URL on that same origin. The pairing code is minted only when the
 * operator asks to open a Session. It is not a reusable password.
 */

import { openCodeBasicAuthHeaders } from "./owned-server.js"
import {
  normalizeOpenCodeServerBase,
  openCodeSessionWebUrl,
} from "./session-web-url.js"

export const OPENCODE_SESSION_HANDOFF_UNAVAILABLE =
  "OpenCode is not available for this Session. The window was not opened."

export const OPENCODE_SESSION_HANDOFF_SHARED_MISSING =
  "The OpenCode service is not available, so this Session was not opened. Start the OpenCode service, then try again."

export const OPENCODE_SESSION_HANDOFF_REJECTED =
  "Could not connect this browser to the OpenCode server for this Session. Try again."

const PAIR_TIMEOUT_MS = 5_000
const CODE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

export type OpenCodeHandoffServer = {
  readonly kind: "server"
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
  readonly mode: "owned" | "explicit" | "shared"
}

export type OpenCodeHandoffSelection =
  | OpenCodeHandoffServer
  | { readonly kind: "unavailable"; readonly message: string }

export type OpenCodeSessionLaunch = {
  readonly connectUrl: string
  readonly sessionUrl: string
}

export type OpenCodeSessionHandoff =
  | { readonly kind: "ready"; readonly launch: OpenCodeSessionLaunch }
  | { readonly kind: "unavailable"; readonly message: string }

/**
 * Same server the agent would use. An owned or explicit server never falls
 * through to shared discovery. Discovery is consulted only for the default
 * connection, and only with the endpoint the caller already resolved.
 */
export const selectOpenCodeHandoffServer = (input: {
  readonly connection:
    | {
        readonly kind: "dedicated"
        readonly baseUrl: string
        readonly headers: Readonly<Record<string, string>>
        readonly unavailable?: string
      }
    | { readonly kind: "blocked"; readonly message: string }
    | {
        readonly kind: "explicit"
        readonly baseUrl: string
        readonly headers?: Readonly<Record<string, string>>
      }
    | { readonly kind: "default" }
  readonly discovered?: {
    readonly baseUrl: string
    readonly headers?: Readonly<Record<string, string>>
  } | null
}): OpenCodeHandoffSelection => {
  if (input.connection.kind === "blocked") {
    return { kind: "unavailable", message: input.connection.message }
  }
  if (input.connection.kind === "dedicated") {
    const unavailable = input.connection.unavailable?.trim()
    if (unavailable !== undefined && unavailable.length > 0) {
      return { kind: "unavailable", message: unavailable }
    }
    const baseUrl = normalizeOpenCodeServerBase(input.connection.baseUrl)
    if (baseUrl === null) {
      return {
        kind: "unavailable",
        message: OPENCODE_SESSION_HANDOFF_UNAVAILABLE,
      }
    }
    return {
      kind: "server",
      baseUrl,
      headers: input.connection.headers,
      mode: "owned",
    }
  }
  if (input.connection.kind === "explicit") {
    const baseUrl = normalizeOpenCodeServerBase(input.connection.baseUrl)
    if (baseUrl === null) {
      return {
        kind: "unavailable",
        message: OPENCODE_SESSION_HANDOFF_UNAVAILABLE,
      }
    }
    return {
      kind: "server",
      baseUrl,
      ...(input.connection.headers === undefined
        ? {}
        : { headers: input.connection.headers }),
      mode: "explicit",
    }
  }
  const discovered = input.discovered
  if (discovered === undefined || discovered === null) {
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_SHARED_MISSING,
    }
  }
  const baseUrl = normalizeOpenCodeServerBase(discovered.baseUrl)
  if (baseUrl === null) {
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_SHARED_MISSING,
    }
  }
  return {
    kind: "server",
    baseUrl,
    ...(discovered.headers === undefined
      ? {}
      : { headers: discovered.headers }),
    mode: "shared",
  }
}

export const openCodeBasicAuthFromPassword = (
  password: string | undefined,
): Readonly<Record<string, string>> | undefined => {
  const trimmed = password?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  return openCodeBasicAuthHeaders(trimmed)
}

/** `<server>/auth/connect/<code>`. No credentials, query, or fragment. */
export const openCodeConnectUrl = (input: {
  readonly serverBase: string
  readonly code: string
}): string | null => {
  const serverBase = normalizeOpenCodeServerBase(input.serverBase)
  const code = input.code.trim()
  if (serverBase === null || !CODE_PATTERN.test(code)) return null
  return `${serverBase}/auth/connect/${encodeURIComponent(code)}`
}

export const openCodeSessionLaunch = (input: {
  readonly serverBase: string
  readonly sessionId: string
  readonly code: string
}): OpenCodeSessionLaunch | null => {
  const connectUrl = openCodeConnectUrl(input)
  const sessionUrl = openCodeSessionWebUrl({
    serverBase: input.serverBase,
    sessionId: input.sessionId,
  })
  if (connectUrl === null || sessionUrl === null) return null
  try {
    if (new URL(connectUrl).origin !== new URL(sessionUrl).origin) return null
  } catch {
    return null
  }
  return { connectUrl, sessionUrl }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseOpenCodePairingCode = (
  body: unknown,
): { readonly code: string; readonly expiresIn: number } | null => {
  if (!isRecord(body) || typeof body["code"] !== "string") return null
  const code = body["code"].trim()
  if (!CODE_PATTERN.test(code)) return null
  const expiresIn = body["expires_in"]
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null
  return { code, expiresIn }
}

export const redactOpenCodeHandoffSecrets = (
  text: string,
  secrets: ReadonlyArray<string>,
): string => {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    redacted = redacted.split(secret).join("[redacted]")
  }
  return redacted
}

/**
 * Authenticated `POST /api/pair` against the server the agent uses.
 * The returned code is single-use. Failures never include the password,
 * response body, or capability URL.
 */
export const requestOpenCodePairingCode = async (input: {
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}): Promise<
  | { readonly kind: "code"; readonly code: string; readonly expiresIn: number }
  | { readonly kind: "failed"; readonly message: string }
> => {
  const baseUrl = normalizeOpenCodeServerBase(input.baseUrl)
  if (baseUrl === null) {
    return { kind: "failed", message: OPENCODE_SESSION_HANDOFF_UNAVAILABLE }
  }
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(input.headers ?? {}),
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? PAIR_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { kind: "failed", message: OPENCODE_SESSION_HANDOFF_REJECTED }
    }
    const parsed = parseOpenCodePairingCode(await response.json())
    if (parsed === null) {
      return { kind: "failed", message: OPENCODE_SESSION_HANDOFF_REJECTED }
    }
    return { kind: "code", code: parsed.code, expiresIn: parsed.expiresIn }
  } catch {
    // Never surface the thrown text. It can contain the server password.
    return { kind: "failed", message: OPENCODE_SESSION_HANDOFF_UNAVAILABLE }
  }
}

export const mintOpenCodeSessionHandoff = async (input: {
  readonly server: OpenCodeHandoffSelection
  readonly sessionId: string
  readonly pair?: typeof requestOpenCodePairingCode
}): Promise<OpenCodeSessionHandoff> => {
  if (input.server.kind === "unavailable") {
    return { kind: "unavailable", message: input.server.message }
  }
  const sessionId = input.sessionId.trim()
  if (sessionId.length === 0) {
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_UNAVAILABLE,
    }
  }
  const pair = input.pair ?? requestOpenCodePairingCode
  const paired = await pair({
    baseUrl: input.server.baseUrl,
    ...(input.server.headers === undefined
      ? {}
      : { headers: input.server.headers }),
  })
  if (paired.kind === "failed") {
    return { kind: "unavailable", message: paired.message }
  }
  const launch = openCodeSessionLaunch({
    serverBase: input.server.baseUrl,
    sessionId,
    code: paired.code,
  })
  if (launch === null) {
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_UNAVAILABLE,
    }
  }
  return { kind: "ready", launch }
}
