/**
 * Vite-style listen host resolution for the Harness application server.
 *
 * Default remains loopback (`127.0.0.1`). Operators opt into non-loopback bind
 * with `--host` / `--host <addr>` or `HOST` (flag wins over env). The Keymaxxer
 * Sidecar is unaffected and stays loopback-only (ADR 0004).
 */

export const DEFAULT_LISTEN_HOST = "127.0.0.1"
export const ALL_INTERFACES_HOST = "0.0.0.0"

/**
 * Normalize a Vite-style host token to a concrete bind address.
 *
 * - empty / `true` / `0.0.0.0` → all IPv4 interfaces
 * - `false` → loopback default
 * - `::` / `[::]` → all IPv6 interfaces
 * - otherwise the trimmed address (e.g. a single LAN IP)
 */
export const normalizeHostToken = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed === "" || trimmed === "true" || trimmed === "0.0.0.0") {
    return ALL_INTERFACES_HOST
  }
  if (trimmed === "false") {
    return DEFAULT_LISTEN_HOST
  }
  if (trimmed === "::" || trimmed === "[::]") {
    return "::"
  }
  return trimmed
}

/**
 * Resolve the Harness bind host from an optional CLI flag and `HOST` env.
 * Flag wins when provided (including after bare `--host` expansion).
 */
export const resolveListenHost = (input: {
  readonly flag?: string | undefined
  readonly env?: string | undefined
}): string => {
  if (input.flag !== undefined) {
    return normalizeHostToken(input.flag)
  }
  const env = input.env?.trim()
  if (env !== undefined && env !== "") {
    return normalizeHostToken(env)
  }
  return DEFAULT_LISTEN_HOST
}

/**
 * Canonical host form for equality checks.
 * Strips outer IPv6 brackets and lowercases so Bun's bracketed
 * `request.url` hostname matches an unbracketed bind host (and vice versa).
 */
export const canonicalizeHostname = (hostname: string): string => {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]") && host.length >= 2) {
    host = host.slice(1, -1)
  }
  return host
}

/** Whether the bind host is a wildcard that cannot appear in client Host headers. */
export const isWildcardBindHost = (hostname: string): boolean => {
  const host = canonicalizeHostname(hostname)
  return host === "0.0.0.0" || host === "::"
}

/**
 * Production Host admission.
 *
 * Concrete bind hosts keep equality after canonicalization (reject wrong Host
 * → 421). Wildcard binds accept any Host: clients send a LAN IP or hostname,
 * never `0.0.0.0` / `::`. Operator opt-in via `--host` / `HOST` is intentional
 * LAN exposure; GraphQL same-origin browser checks stay unchanged.
 */
export const isRequestHostAdmitted = (input: {
  readonly requestHostname: string
  readonly bindHostname: string
}): boolean => {
  if (isWildcardBindHost(input.bindHostname)) {
    return true
  }
  return (
    canonicalizeHostname(input.requestHostname) ===
    canonicalizeHostname(input.bindHostname)
  )
}

/**
 * Host authority for an HTTP URL. IPv6 literals need brackets
 * (`http://[::]:6056/`); IPv4 and names do not.
 */
export const hostAuthorityForUrl = (hostname: string): string => {
  const host = hostname.trim()
  if (host.startsWith("[") && host.endsWith("]")) {
    return host
  }
  // Unbracketed IPv6 (including zone ids) always contains ':'.
  if (host.includes(":")) {
    return `[${host}]`
  }
  return host
}

/** Readiness / listen log URL (reflects the configured bind host). */
export const formatListenUrl = (hostname: string, port: number): string =>
  `http://${hostAuthorityForUrl(hostname)}:${port}/`

/**
 * Browser auto-open URL for the configured bind host.
 *
 * Wildcard binds (`0.0.0.0` / `::`) open loopback: browsers mishandle
 * `http://0.0.0.0:...`, and a wildcard listener is reachable on 127.0.0.1.
 * Concrete bind hosts open that address so the opener hits the socket that
 * was actually bound (e.g. a single LAN IP is not on loopback).
 */
export const resolveBrowserOpenUrl = (
  port: number,
  bindHostname: string = DEFAULT_LISTEN_HOST,
): string => {
  if (isWildcardBindHost(bindHostname)) {
    return formatListenUrl(DEFAULT_LISTEN_HOST, port)
  }
  return formatListenUrl(bindHostname, port)
}

/**
 * Expand bare `--host` / `--host=` into `--host 0.0.0.0` so Effect's string
 * flag parser accepts Vite-style usage without a value token.
 */
export const expandBareHostFlag = (
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--host") {
      const next = args[i + 1]
      if (next === undefined || next.startsWith("-")) {
        out.push("--host", ALL_INTERFACES_HOST)
      } else {
        out.push("--host", next)
        i += 1
      }
      continue
    }
    if (arg.startsWith("--host=")) {
      const value = arg.slice("--host=".length)
      out.push("--host", value === "" ? ALL_INTERFACES_HOST : value)
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Parse `--host` / `--host=<addr>` from argv for hosts that do not use Effect
 * CLI (production `server.ts`, lifecycle options).
 *
 * Returns the raw token (not normalized); pass through `resolveListenHost`.
 * Bare `--host` yields `0.0.0.0`. Omitted flag yields `undefined`.
 */
export const parseHostFlagFromArgv = (
  argv: ReadonlyArray<string>,
): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === "--host") {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        return ALL_INTERFACES_HOST
      }
      return next
    }
    if (arg.startsWith("--host=")) {
      const value = arg.slice("--host=".length)
      return value === "" ? ALL_INTERFACES_HOST : value
    }
  }
  return undefined
}
