/**
 * Resolve the OpenCode server address the agent actually uses.
 *
 * An explicitly configured server wins. Otherwise the address is whatever
 * `opencode service status` prints for the shared local service. This does
 * not start the service and does not rewrite the address to the harness origin.
 */

import { normalizeOpenCodeServerBase } from "./session-web-url.js"

const STATUS_URL = /^(https?:\/\/\S+)/

export const parseOpenCodeServiceStatus = (stdout: string): string | null => {
  for (const line of stdout.split(/\r?\n/)) {
    const match = STATUS_URL.exec(line.trim())
    const candidate = match?.[1]
    if (candidate === undefined) continue
    const normalized = normalizeOpenCodeServerBase(candidate)
    if (normalized !== null) return normalized
  }
  return null
}

export type ResolveOpenCodeServerBaseInput = {
  /** Same base the agent layer passes as `--server`, when configured. */
  readonly explicitServerBase?: string
  /**
   * Runs `opencode service status` (or a test double). Required when no
   * explicit server is configured.
   */
  readonly serviceStatus?: () => Promise<string>
}

/**
 * Browser-reachable OpenCode server base, or null when it cannot be resolved.
 * Does not fall through to service status when an explicit server is set but
 * unusable — that server is the one the agent would use.
 */
export const resolveOpenCodeServerBase = async (
  input: ResolveOpenCodeServerBaseInput = {},
): Promise<string | null> => {
  const explicit = input.explicitServerBase
  if (explicit !== undefined && explicit.trim().length > 0) {
    return normalizeOpenCodeServerBase(explicit)
  }
  const serviceStatus = input.serviceStatus
  if (serviceStatus === undefined) return null
  try {
    return parseOpenCodeServiceStatus(await serviceStatus())
  } catch {
    return null
  }
}

const DEFAULT_STATUS_TIMEOUT_MS = 3_000
const DEFAULT_STATUS_TTL_MS = 5_000

/** `opencode service status` stdout. Does not start the service. */
export const readOpenCodeServiceStatus = async (input?: {
  readonly binary?: string
  readonly timeoutMs?: number
}): Promise<string> => {
  const binary = input?.binary ?? "opencode"
  const timeoutMs = input?.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS
  const proc = Bun.spawn([binary, "service", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const timer = setTimeout(() => {
    proc.kill()
  }, timeoutMs)
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (code !== 0) {
      throw new Error(`opencode service status exited ${String(code)}`)
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One status lookup shared across Work Item list polls. An explicit server
 * never calls `service status`.
 */
export const makeOpenCodeServerBaseResolver = (input?: {
  readonly explicitServerBase?: string
  readonly serviceStatus?: () => Promise<string>
  readonly now?: () => number
  readonly ttlMs?: number
}): (() => Promise<string | null>) => {
  const ttlMs = input?.ttlMs ?? DEFAULT_STATUS_TTL_MS
  const now = input?.now ?? Date.now
  let cached: { readonly at: number; readonly value: string | null } | null =
    null
  let inflight: Promise<string | null> | null = null

  return async () => {
    const explicit = input?.explicitServerBase
    if (explicit !== undefined && explicit.trim().length > 0) {
      return resolveOpenCodeServerBase({ explicitServerBase: explicit })
    }
    const at = now()
    if (cached !== null && at - cached.at < ttlMs) return cached.value
    if (inflight !== null) return inflight
    const pending = resolveOpenCodeServerBase({
      ...(input?.serviceStatus === undefined
        ? { serviceStatus: () => readOpenCodeServiceStatus() }
        : { serviceStatus: input.serviceStatus }),
    }).then((value) => {
      cached = { at: now(), value }
      return value
    })
    inflight = pending
    try {
      return await pending
    } finally {
      if (inflight === pending) inflight = null
    }
  }
}
