import { Clock, Duration, Effect, Fiber, Queue, Ref, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  AgentBackendConfigError,
  AgentBackendNotInstalledError,
  AgentBackendTimeoutError,
  type AgentModel,
  DEFAULT_FORCE_KILL_AFTER,
  collectChildStderrTail,
  findSpawnNotFoundCode,
  formatAgentCliNotFoundRemediation,
  killProcessTree,
  scrubProviderCredentialSecrets,
} from "@ready-for-agent/agent-backend"
import { projectAppServerModelList } from "./catalog.js"
import { CODEX_APP_SERVER_DISCOVERY_FAILED_MESSAGE } from "./types.js"

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const
const MAX_PAGES = 64
const MAX_STDOUT_BYTES = 1_048_576
const CLIENT_INFO = {
  name: "ready_for_agent",
  title: "Ready for Agent",
  version: "0",
} as const

type RpcId = string

export type AppServerLine =
  | { readonly kind: "response"; readonly id: RpcId; readonly result: unknown }
  | {
      readonly kind: "error"
      readonly id: RpcId | null
      readonly code: number | null
      readonly message: string
    }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "unrelated" }
  | { readonly kind: "malformed"; readonly reason: string }

type Incoming =
  | AppServerLine
  | { readonly kind: "closed" }
  | { readonly kind: "overflow" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rpcId = (value: unknown): RpcId | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim()
  }
  return null
}

export const encodeAppServerRequest = (input: {
  readonly id: number
  readonly method: string
  readonly params?: unknown
}): string => {
  const body: Record<string, unknown> = {
    method: input.method,
    id: input.id,
  }
  if (input.params !== undefined) {
    body.params = input.params
  }
  return `${JSON.stringify(body)}\n`
}

export const encodeAppServerNotification = (input: {
  readonly method: string
  readonly params?: unknown
}): string => {
  const body: Record<string, unknown> = { method: input.method }
  if (input.params !== undefined) {
    body.params = input.params
  }
  return `${JSON.stringify(body)}\n`
}

/**
 * Classify one newline-delimited app-server JSON object. The wire format has
 * no `jsonrpc` member and no Content-Length framing.
 */
export const parseAppServerLine = (line: string): AppServerLine => {
  const trimmed = line.trim()
  if (trimmed === "") {
    return { kind: "unrelated" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return { kind: "malformed", reason: "line is not JSON" }
  }
  if (!isRecord(parsed)) {
    return { kind: "malformed", reason: "line is not a JSON object" }
  }

  if (isRecord(parsed.error)) {
    const message =
      typeof parsed.error.message === "string" &&
      parsed.error.message.trim() !== ""
        ? parsed.error.message.trim()
        : "RPC error"
    const code =
      typeof parsed.error.code === "number" &&
      Number.isFinite(parsed.error.code)
        ? parsed.error.code
        : null
    return {
      kind: "error",
      id: rpcId(parsed.id),
      code,
      message,
    }
  }

  if ("result" in parsed) {
    const id = rpcId(parsed.id)
    if (id === null) {
      return { kind: "malformed", reason: "RPC result is missing an id" }
    }
    return { kind: "response", id, result: parsed.result }
  }

  if (typeof parsed.method === "string" && !("id" in parsed)) {
    return { kind: "notification", method: parsed.method }
  }

  return { kind: "unrelated" }
}

const TOKEN_SHAPED_RE =
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bsk-ant-[A-Za-z0-9_-]{16,}\b|\bsk-[A-Za-z0-9]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

const sanitizeProbeText = (text: string): string =>
  scrubProviderCredentialSecrets(
    text.replace(TOKEN_SHAPED_RE, "[redacted]"),
  ).trim()

const clip = (text: string, maxChars = 240): string => {
  const trimmed = sanitizeProbeText(text).replace(/\s+/g, " ")
  if (trimmed.length === 0) {
    return "(no output)"
  }
  if (trimmed.length <= maxChars) {
    return trimmed
  }
  return `${trimmed.slice(0, maxChars)}…`
}

const configError = (detail: string): AgentBackendConfigError =>
  new AgentBackendConfigError({
    message: CODEX_APP_SERVER_DISCOVERY_FAILED_MESSAGE(detail),
  })

const mapSpawnError = (
  error: PlatformError,
  input: {
    readonly binary: string
  },
): PlatformError | AgentBackendNotInstalledError => {
  if (findSpawnNotFoundCode(error) === undefined) {
    return error
  }
  return new AgentBackendNotInstalledError({
    message: formatAgentCliNotFoundRemediation({
      backendLabel: "Codex Build",
      binary: input.binary,
    }),
    backend: { id: "codex", label: "Codex Build" },
    binary: input.binary,
    cause: error,
  })
}

const terminateCliTree = (
  handle: ChildProcessHandle,
  forceKillAfter: Duration.Input,
): Effect.Effect<void> =>
  killProcessTree(Number(handle.pid), { forceKillAfter }).pipe(
    Effect.timeout(Duration.millis(Duration.toMillis(forceKillAfter) + 1_000)),
    Effect.ignore,
  )

const nextCursorOf = (result: unknown): string | null => {
  if (!isRecord(result)) {
    return null
  }
  const cursor = result.nextCursor
  if (typeof cursor !== "string") {
    return null
  }
  const trimmed = cursor.trim()
  return trimmed === "" ? null : trimmed
}

const unsupportedCliDetail = (message: string): string => {
  const lower = message.toLowerCase()
  if (
    lower.includes("unrecognized subcommand") ||
    lower.includes("unexpected argument") ||
    lower.includes("method not found") ||
    lower.includes("unknown method") ||
    message.includes("-32601")
  ) {
    return `unsupported Codex CLI: ${clip(message)}`
  }
  return clip(message)
}

export const discoverAppServerModels = (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly binary: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeout: Duration.Input
}): Effect.Effect<
  ReadonlyArray<AgentModel>,
  | AgentBackendConfigError
  | AgentBackendTimeoutError
  | AgentBackendNotInstalledError
  | PlatformError
> =>
  Effect.gen(function* () {
    const timeoutMs = Duration.toMillis(input.timeout)
    const forceKillAfter = DEFAULT_FORCE_KILL_AFTER
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const stdinQueue = yield* Queue.unbounded<string>()
    const incoming = yield* Queue.unbounded<Incoming>()
    const stderrTail = yield* Ref.make("")
    const stdoutBytes = yield* Ref.make(0)
    let stderrFiber: Fiber.Fiber<string, PlatformError> | undefined
    let nextId = 1
    const collected: unknown[] = []
    const seenCursors = new Set<string>()

    const remaining = (): Effect.Effect<Duration.Duration> =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => Duration.millis(Math.max(0, deadline - now))),
      )

    const failTimeout = (): Effect.Effect<never, AgentBackendConfigError> =>
      Effect.fail(configError("model/list discovery timed out"))

    const write = (
      text: string,
    ): Effect.Effect<void, AgentBackendConfigError> =>
      Queue.offer(stdinQueue, text).pipe(
        Effect.asVoid,
        Effect.catch(() =>
          Effect.fail(configError("failed to write app-server request")),
        ),
      )

    const waitFor = (
      id: RpcId,
    ): Effect.Effect<unknown, AgentBackendConfigError> =>
      Effect.gen(function* () {
        for (;;) {
          const left = yield* remaining()
          if (Duration.toMillis(left) <= 0) {
            return yield* failTimeout()
          }
          const message = yield* Queue.take(incoming).pipe(
            Effect.timeout(left),
            Effect.catchTag("TimeoutError", () => failTimeout()),
            Effect.mapError((error) => {
              if (error instanceof AgentBackendConfigError) {
                return error
              }
              return configError("app-server stream closed")
            }),
          )
          if (message.kind === "overflow") {
            return yield* Effect.fail(
              configError("app-server stdout exceeded the discovery bound"),
            )
          }
          if (message.kind === "closed") {
            if (stderrFiber !== undefined) {
              yield* Fiber.join(stderrFiber).pipe(Effect.ignore)
            }
            const tail = (yield* Ref.get(stderrTail)).trim()
            const detail =
              tail.length > 0
                ? unsupportedCliDetail(tail)
                : "app-server exited before completing model/list"
            return yield* Effect.fail(configError(detail))
          }
          if (message.kind === "malformed") {
            return yield* Effect.fail(configError(message.reason))
          }
          if (message.kind === "notification" || message.kind === "unrelated") {
            continue
          }
          if (message.kind === "error") {
            if (message.id !== null && message.id !== id) {
              continue
            }
            return yield* Effect.fail(
              configError(unsupportedCliDetail(message.message)),
            )
          }
          if (message.id !== id) {
            continue
          }
          return message.result
        }
      })

    const request = (
      method: string,
      params?: unknown,
    ): Effect.Effect<unknown, AgentBackendConfigError> =>
      Effect.gen(function* () {
        const id = nextId
        nextId += 1
        yield* write(
          encodeAppServerRequest({
            id,
            method,
            ...(params !== undefined ? { params } : {}),
          }),
        )
        return yield* waitFor(String(id))
      })

    const command = ChildProcess.make(input.binary, [...APP_SERVER_ARGS], {
      cwd: input.cwd,
      env: input.env,
      extendEnv: false,
      stdin: { stream: "pipe", endOnDone: false },
      stdout: "pipe",
      stderr: "pipe",
      detached: false,
      killSignal: "SIGTERM",
      forceKillAfter,
    })

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* input.spawner
          .spawn(command)
          .pipe(Effect.mapError((error) => mapSpawnError(error, input)))
        yield* Effect.addFinalizer(() =>
          terminateCliTree(handle, forceKillAfter).pipe(
            Effect.andThen(Queue.shutdown(stdinQueue)),
            Effect.andThen(Queue.shutdown(incoming)),
          ),
        )

        yield* Stream.fromQueue(stdinQueue).pipe(
          Stream.encodeText,
          Stream.run(handle.stdin),
          Effect.forkScoped,
        )

        stderrFiber = yield* collectChildStderrTail(handle).pipe(
          Effect.tap((tail) => Ref.set(stderrTail, tail)),
          Effect.forkScoped,
        )

        yield* handle.exitCode.pipe(
          Effect.andThen(Queue.offer(incoming, { kind: "closed" as const })),
          Effect.catch(() =>
            Queue.offer(incoming, { kind: "closed" as const }),
          ),
          Effect.forkScoped,
        )

        yield* Stream.decodeText(handle.stdout).pipe(
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              const total = yield* Ref.updateAndGet(
                stdoutBytes,
                (current) => current + Buffer.byteLength(line, "utf8") + 1,
              )
              if (total > MAX_STDOUT_BYTES) {
                yield* Queue.offer(incoming, { kind: "overflow" })
                return
              }
              yield* Queue.offer(incoming, parseAppServerLine(line))
            }),
          ),
          Effect.catch(() => Effect.void),
          Effect.forkScoped,
        )

        yield* request("initialize", { clientInfo: CLIENT_INFO })
        yield* write(encodeAppServerNotification({ method: "initialized" }))

        let cursor: string | undefined
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const params: {
            readonly includeHidden: false
            readonly cursor?: string
          } =
            cursor === undefined
              ? { includeHidden: false }
              : { includeHidden: false, cursor }
          const result = yield* request("model/list", params)
          if (!isRecord(result) || !Array.isArray(result.data)) {
            return yield* Effect.fail(
              configError("model/list result is missing a data array"),
            )
          }
          collected.push(...result.data)
          const nextCursor = nextCursorOf(result)
          if (nextCursor === null) {
            const projected = projectAppServerModelList({ data: collected })
            if (projected.kind === "malformed") {
              return yield* Effect.fail(configError(projected.reason))
            }
            if (projected.kind === "empty") {
              return yield* Effect.fail(
                configError("model/list returned no usable models"),
              )
            }
            return projected.models
          }
          if (seenCursors.has(nextCursor)) {
            return yield* Effect.fail(
              configError("model/list repeated a pagination cursor"),
            )
          }
          seenCursors.add(nextCursor)
          cursor = nextCursor
        }
        return yield* Effect.fail(
          configError("model/list pagination exceeded the page bound"),
        )
      }),
    ).pipe(
      Effect.timeout(input.timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new AgentBackendTimeoutError({
            cwd: input.cwd,
            timeoutMs,
          }),
        ),
      ),
      Effect.catchIf(
        (error): error is AgentBackendTimeoutError =>
          error instanceof AgentBackendTimeoutError,
        () => failTimeout(),
      ),
    )
  })
