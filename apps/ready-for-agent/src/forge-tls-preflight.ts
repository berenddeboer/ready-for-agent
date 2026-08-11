import * as tls from "node:tls"
import {
  findTlsTrustCode,
  formatTlsTrustRemediation,
} from "@ready-for-agent/github-service"
import type { ForgeApiEndpoint } from "./peek-repository-forges.ts"

type ForgeTlsPreflightFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>

export type ForgeTlsPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly host: string
      readonly code: string
      readonly issuer: string | null
      readonly message: string
    }

export type ForgeTlsPreflightOptions = {
  readonly endpoints: ReadonlyArray<ForgeApiEndpoint>
  readonly fetchImpl?: ForgeTlsPreflightFetch
  readonly timeoutMs?: number
  /**
   * Optional issuer probe (defaults to a short `tls.connect` with
   * `rejectUnauthorized: false` so the presented chain can be read after a
   * trust failure).
   */
  readonly readIssuer?: (host: string) => Promise<string | null>
}

const DEFAULT_TIMEOUT_MS = 15_000

const parseHostPort = (
  host: string,
): { readonly hostname: string; readonly port: number } => {
  const withPort = /^(.+):(\d+)$/.exec(host)
  if (withPort?.[1] !== undefined && withPort[2] !== undefined) {
    const port = Number(withPort[2])
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      return { hostname: withPort[1], port }
    }
  }
  return { hostname: host, port: 443 }
}

/**
 * After a trust failure, reconnect without verification so we can name the
 * private CA (Netskope / Zscaler / etc.) in the operator message.
 */
const readPresentedCertificateIssuer = (
  host: string,
  timeoutMs = 5_000,
): Promise<string | null> => {
  const { hostname, port } = parseHostPort(host)
  return new Promise((resolve) => {
    let settled = false
    const finish = (issuer: string | null) => {
      if (settled) return
      settled = true
      resolve(issuer)
    }

    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate(true)
        socket.end()
        finish(formatPeerCertificateIssuer(cert))
      },
    )
    socket.on("error", () => {
      finish(null)
    })
    socket.on("timeout", () => {
      socket.destroy()
      finish(null)
    })
  })
}

const readIssuerField = (issuer: object, key: string): string | null => {
  if (!(key in issuer)) return null
  const value = Reflect.get(issuer, key)
  if (typeof value !== "string" || value.trim() === "") return null
  return value.trim()
}

/** PeerCertificate.issuer is an OpenSSL name object; read O/CN without casts. */
const formatPeerCertificateIssuer = (cert: unknown): string | null => {
  if (cert === null || typeof cert !== "object") return null
  if (!("issuer" in cert)) return null
  const issuer = Reflect.get(cert, "issuer")
  if (issuer === null || typeof issuer !== "object") return null
  const organization = readIssuerField(issuer, "O")
  const commonName = readIssuerField(issuer, "CN")
  if (organization !== null && commonName !== null) {
    return `${organization} / ${commonName}`
  }
  return organization ?? commonName
}

/**
 * Cheap HTTPS probe per configured forge API host. Only TLS trust failures
 * fail the preflight; network blips and HTTP auth errors do not block start.
 */
export const checkForgeTlsTrust = async (
  options: ForgeTlsPreflightOptions,
): Promise<ForgeTlsPreflightResult> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const readIssuer = options.readIssuer ?? readPresentedCertificateIssuer

  for (const endpoint of options.endpoints) {
    const url = `https://${endpoint.host}${endpoint.path}`
    try {
      await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      })
      // Any HTTP response means the TLS handshake succeeded.
    } catch (cause) {
      const code = findTlsTrustCode(cause)
      if (code === undefined) {
        // DNS / connect / timeout: do not block cold start.
        continue
      }
      const issuer = await readIssuer(endpoint.host)
      const message = formatTlsTrustRemediation({
        host: endpoint.host,
        code,
        issuer,
      })
      return {
        ok: false,
        host: endpoint.host,
        code,
        issuer,
        message,
      }
    }
  }

  return { ok: true }
}
