/**
 * Harness-owned OpenCode V2 server used only while Keymaxxer is enabled.
 *
 * OpenCode 2.0.32 reads `OPENCODE_CONFIG_CONTENT` when the server process
 * starts. A client env override is not applied to the shared background
 * service. `opencode serve` (without `--service`) is the supported private
 * server. Clients authenticate with `OPENCODE_PASSWORD`; the server password
 * is `OPENCODE_SERVER_PASSWORD`. Username is `opencode`.
 */

import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { Effect } from "effect"
import { makeOpencodeEnvironment } from "./environment.js"
import type { ConnectOpencodeV2Result } from "./opencode-v2-client.js"
import { persistentFailure } from "./opencode-v2-compatibility.js"

const LOOPBACK_HOST = "127.0.0.1"
const DEFAULT_READY_TIMEOUT_MS = 15_000
const STOP_GRACE_MS = 3_000
const STDERR_TAIL_LIMIT = 4_000
const OPENCODE_BASIC_USERNAME = "opencode"

export const ownedOpenCodeServerStartupFailureMessage = (
  detail: string,
): string =>
  `Keymaxxer is enabled, but the harness-owned OpenCode server did not become ready. The shared OpenCode service was not used. ${detail} Restart the harness after OpenCode can start a private server.`

export const OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE =
  "The harness-owned OpenCode server is unavailable. Keymaxxer is enabled, so this request was not sent to the shared OpenCode service. Restart the harness."

export const OWNED_OPENCODE_SERVER_MISSING_MESSAGE =
  "Keymaxxer is enabled, but the harness did not start its OpenCode server. The shared OpenCode service was not used. Restart the harness."

/** True only for the effective Keymaxxer capability URL, not for selecting OpenCode. */
export const keymaxxerRequiresOwnedOpenCodeServer = (
  keymaxxerMcpUrl: string | undefined,
): keymaxxerMcpUrl is string => {
  const trimmed = keymaxxerMcpUrl?.trim()
  return trimmed !== undefined && trimmed.length > 0
}

export const redactOpenCodeSecrets = (
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

/** Telemetry must not discover the shared service when the owned server is down. */
export const blockedOpenCodeSessionConnect =
  (message: string) => async (): Promise<ConnectOpencodeV2Result> =>
    persistentFailure(message)

export const openCodeBasicAuthHeaders = (
  password: string,
): Readonly<Record<string, string>> => ({
  authorization: `Basic ${Buffer.from(`${OPENCODE_BASIC_USERNAME}:${password}`).toString("base64")}`,
})

/**
 * `opencode serve` arguments. Never includes `--service`, which would
 * register or replace the user's shared background service.
 */
export const ownedOpenCodeServeArgs = (port: number): ReadonlyArray<string> => [
  "serve",
  "--hostname",
  LOOPBACK_HOST,
  "--port",
  String(port),
]

export type HarnessOpenCodeConnection =
  | { readonly kind: "dedicated"; readonly baseUrl: string }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "explicit"; readonly baseUrl: string }
  | { readonly kind: "default" }

/**
 * Fail closed when Keymaxxer is enabled and the owned server is missing.
 * An explicit server is not a substitute: it does not have the injected
 * Keymaxxer override. Disabled Keymaxxer keeps the explicit server or the
 * default shared-service connection.
 */
export const selectHarnessOpenCodeConnection = (input: {
  readonly keymaxxerMcpUrl?: string
  readonly ownedBaseUrl?: string
  readonly explicitBaseUrl?: string
  readonly startupFailure?: string
}): HarnessOpenCodeConnection => {
  if (!keymaxxerRequiresOwnedOpenCodeServer(input.keymaxxerMcpUrl)) {
    const explicit = input.explicitBaseUrl?.trim()
    if (explicit !== undefined && explicit.length > 0) {
      return { kind: "explicit", baseUrl: explicit }
    }
    return { kind: "default" }
  }
  const failure = input.startupFailure?.trim()
  if (failure !== undefined && failure.length > 0) {
    return { kind: "blocked", message: failure }
  }
  const owned = input.ownedBaseUrl?.trim()
  if (owned === undefined || owned.length === 0) {
    return {
      kind: "blocked",
      message: OWNED_OPENCODE_SERVER_MISSING_MESSAGE,
    }
  }
  return { kind: "dedicated", baseUrl: owned }
}

export type OwnedOpenCodeServer = {
  readonly baseUrl: string
  readonly password: string
  readonly headers: Readonly<Record<string, string>>
  readonly pid: number
  /** Undefined when the process is still the one this handle started. */
  readonly assertAvailable: () => string | undefined
  readonly dispose: () => Promise<void>
}

export type StartOwnedOpenCodeServerOptions = {
  readonly keymaxxerMcpUrl: string
  readonly binary?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly readyTimeoutMs?: number
  readonly spawn?: (
    args: ReadonlyArray<string>,
    env: Record<string, string>,
  ) => Bun.Subprocess
}

const reserveLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(
          new Error(
            "Could not reserve a loopback port for the harness-owned OpenCode server.",
          ),
        )
        return
      }
      const { port } = address
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve(port)
      })
    })
  })

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const stopProcess = async (proc: Bun.Subprocess): Promise<void> => {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill("SIGTERM")
  const exited = await Promise.race([
    proc.exited.then(() => true),
    sleep(STOP_GRACE_MS).then(() => false),
  ])
  if (!exited && proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL")
    await proc.exited
  }
}

const readStderrTail = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => {
  if (stream === null) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let tail = ""
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      tail += decoder.decode(next.value, { stream: true })
      if (tail.length > STDERR_TAIL_LIMIT) {
        tail = tail.slice(-STDERR_TAIL_LIMIT)
      }
    }
  } catch {
    return tail
  }
  return tail
}

export const startOwnedOpenCodeServer = async (
  options: StartOwnedOpenCodeServerOptions,
): Promise<OwnedOpenCodeServer> => {
  const keymaxxerMcpUrl = options.keymaxxerMcpUrl.trim()
  if (!keymaxxerRequiresOwnedOpenCodeServer(keymaxxerMcpUrl)) {
    throw new Error(OWNED_OPENCODE_SERVER_MISSING_MESSAGE)
  }
  const password = randomBytes(32).toString("base64url")
  const secrets = [password, keymaxxerMcpUrl]
  const fail = (detail: string): never => {
    throw new Error(
      ownedOpenCodeServerStartupFailureMessage(
        redactOpenCodeSecrets(detail, secrets),
      ),
    )
  }

  const environment = await Effect.runPromise(
    makeOpencodeEnvironment({
      keymaxxerMcpUrl,
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
    }),
  ).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "invalid OpenCode configuration"
    return fail(message)
  })
  const serverEnv: Record<string, string> = {
    ...environment,
    OPENCODE_SERVER_PASSWORD: password,
  }
  const binary = options.binary ?? "opencode"
  const port = await reserveLoopbackPort().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "could not reserve a port"
    return fail(message)
  })
  const baseUrl = `http://${LOOPBACK_HOST}:${String(port)}`
  const args = ownedOpenCodeServeArgs(port)
  let proc: Bun.Subprocess
  try {
    proc =
      options.spawn?.(args, serverEnv) ??
      Bun.spawn({
        cmd: [binary, ...args],
        env: serverEnv,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      })
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to spawn"
    return fail(`Could not run '${binary} serve'. ${message}`)
  }

  const stderr =
    proc.stderr !== undefined && typeof proc.stderr !== "number"
      ? proc.stderr
      : null
  const stderrTail = readStderrTail(stderr)
  let settled = false
  let exitCode: number | null = null
  let disposePromise: Promise<void> | undefined
  proc.exited.then((code) => {
    exitCode = code
  })

  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    settled = true
    disposePromise = stopProcess(proc).finally(() => {
      void stderrTail.then(() => undefined)
    })
    return disposePromise
  }

  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const headers = openCodeBasicAuthHeaders(password)
  const deadline = Date.now() + readyTimeoutMs
  try {
    for (;;) {
      if (exitCode !== null) {
        const tail = redactOpenCodeSecrets(await stderrTail, secrets)
        const detail =
          tail.length > 0
            ? `OpenCode exited ${String(exitCode)} before it was ready. ${tail}`
            : `OpenCode exited ${String(exitCode)} before it was ready.`
        return fail(detail)
      }
      try {
        const response = await fetch(`${baseUrl}/api/config`, {
          headers,
          signal: AbortSignal.timeout(1_000),
        })
        if (response.status === 401) {
          return fail(
            "OpenCode rejected the harness server password. Check the OpenCode 2 installation.",
          )
        }
        if (response.ok) {
          const body = await response.text()
          if (!body.includes(keymaxxerMcpUrl)) {
            return fail(
              "OpenCode started without the Keymaxxer MCP override. Refusing to use that server.",
            )
          }
          break
        }
      } catch {
        // Not listening yet, or the request timed out.
      }
      if (Date.now() >= deadline) {
        return fail(
          `OpenCode did not accept connections on ${baseUrl} within ${String(readyTimeoutMs)}ms.`,
        )
      }
      await sleep(100)
    }
  } catch (error) {
    await dispose()
    if (
      error instanceof Error &&
      error.message.includes("shared OpenCode service was not used")
    ) {
      throw error
    }
    return fail(error instanceof Error ? error.message : "startup failed")
  }

  return {
    baseUrl,
    password,
    headers,
    pid: proc.pid,
    assertAvailable: () => {
      if (settled || exitCode !== null) {
        return OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE
      }
      return undefined
    },
    dispose,
  }
}
