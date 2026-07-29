import { generateSubscriptionOp } from "@ready-for-agent/graphql-client"

const operation = generateSubscriptionOp({ repositoriesChanged: true })

/**
 * GraphQL Yoga production SSE ping interval. Source of truth is graphql-yoga's
 * SSE processor (`pingIntervalMs = 12_000` when `NODE_ENV !== "test"`).
 */
export const REPOSITORY_SSE_HEARTBEAT_INTERVAL_MS = 12_000

/**
 * Bound for missing stream activity (Yoga heartbeat comments or GraphQL
 * events) before treating a half-open Repository subscription as stale and
 * initiating one reconnect. Must be strictly longer than
 * {@link REPOSITORY_SSE_HEARTBEAT_INTERVAL_MS}.
 */
export const REPOSITORY_SSE_STALE_AFTER_MS = 45_000

export type RepositoryLiveStreamDisconnectReason =
  | "complete"
  | "stream_ended"
  | "stale"
  | "aborted"
  | "error"

export class RepositorySubscriptionStaleError extends Error {
  readonly heartbeatAgeMs: number

  constructor(heartbeatAgeMs: number) {
    super(
      `Repository change subscription went stale after ${heartbeatAgeMs}ms without activity`,
    )
    this.name = "RepositorySubscriptionStaleError"
    this.heartbeatAgeMs = heartbeatAgeMs
  }
}

export const parseSubscriptionEvent = (
  event: string,
): "next" | "complete" | "comment" | null => {
  // SSE comment frames (Yoga heartbeats): lines that are empty or start with `:`.
  const lines = event.split(/\r?\n/)
  const nonEmpty = lines.filter((line) => line.length > 0)
  if (nonEmpty.length > 0 && nonEmpty.every((line) => line.startsWith(":"))) {
    return "comment"
  }

  let eventType = "message"
  const data: string[] = []

  for (const line of lines) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim()
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }

  if (eventType === "complete") return "complete"
  if (eventType !== "next" && eventType !== "message") return null
  if (data.length === 0) return null

  const result = JSON.parse(data.join("\n")) as {
    data?: { repositoriesChanged?: boolean }
    errors?: unknown
  }
  if (result.errors !== undefined) {
    throw new Error("Repository change subscription failed")
  }
  return result.data?.repositoriesChanged === true ? "next" : null
}

/** How a Repository SSE stream ended when it did not throw. */
export type RepositoryLiveStreamEnd = "complete" | "stream_ended"

/**
 * Open the Repository-changed GraphQL SSE subscription and consume the body
 * immediately.
 *
 * Transport readiness is reported as soon as the HTTP response is accepted —
 * before catch-up work runs. {@link onConnected} and {@link onChange} are not
 * awaited by the reader so a slow, canceled, or failed catch-up cannot block
 * Yoga heartbeats, subsequent notifications, or stream lifetime.
 *
 * Any received chunk (heartbeat comment or event) resets the stale timer.
 * When no activity arrives within {@link staleAfterMs}, the stream aborts with
 * {@link RepositorySubscriptionStaleError}.
 *
 * Returns {@link RepositoryLiveStreamEnd}: `"complete"` for a GraphQL
 * `event: complete` frame, `"stream_ended"` when the body closes without one.
 */
export const streamRepositoryChanges = async ({
  signal,
  onConnected,
  onChange,
  onActivity,
  staleAfterMs = REPOSITORY_SSE_STALE_AFTER_MS,
  fetch: fetchRequest = fetch,
}: {
  signal: AbortSignal
  onConnected: () => void | Promise<void>
  onChange: () => void | Promise<void>
  /** Invoked on every stream activity (heartbeats and application events). */
  onActivity?: (info: { readonly kind: "chunk" | "comment" | "next" }) => void
  staleAfterMs?: number
  fetch?: typeof fetch
}): Promise<RepositoryLiveStreamEnd> => {
  const response = await fetchRequest("/graphql", {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(operation),
    signal,
  })

  if (!response.ok || response.body === null) {
    throw new Error(
      `Repository change subscription returned ${response.status}`,
    )
  }

  // Transport health is established by the successful SSE response. Catch-up
  // must not gate reading the body (Yoga heartbeats + notifications).
  void Promise.resolve()
    .then(() => onConnected())
    .catch(() => undefined)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let lastActivityAt = Date.now()
  let staleTimer: ReturnType<typeof setTimeout> | undefined
  let staleError: RepositorySubscriptionStaleError | undefined

  const clearStaleWatch = () => {
    if (staleTimer !== undefined) {
      clearTimeout(staleTimer)
      staleTimer = undefined
    }
  }

  // Stale path only cancels the reader; settlement always goes through
  // reader.read() so there is no racing Promise left unobserved.
  const armStaleWatch = () => {
    clearStaleWatch()
    if (staleAfterMs === Number.POSITIVE_INFINITY) return
    staleTimer = setTimeout(() => {
      const age = Date.now() - lastActivityAt
      staleError = new RepositorySubscriptionStaleError(age)
      void reader.cancel().catch(() => undefined)
    }, staleAfterMs)
  }

  const noteActivity = (kind: "chunk" | "comment" | "next") => {
    lastActivityAt = Date.now()
    armStaleWatch()
    try {
      onActivity?.({ kind })
    } catch {
      // Activity listeners must not tear down an otherwise healthy stream.
    }
  }

  const throwIfStaleOrAborted = () => {
    if (staleError !== undefined) throw staleError
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError")
    }
  }

  /**
   * Drain complete SSE frames from `buffer`. Returns "complete" when the
   * subscription ends via an event: complete frame.
   */
  const drainFrames = (): "complete" | "continue" => {
    let boundary = buffer.search(/\r?\n\r?\n/)
    while (boundary >= 0) {
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0]
      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + (separator?.length ?? 2))

      const parsed = parseSubscriptionEvent(event)
      if (parsed === "complete") return "complete"
      if (parsed === "comment") {
        noteActivity("comment")
      } else if (parsed === "next") {
        noteActivity("next")
        // Do not await: catch-up latency must not stall the reader.
        void Promise.resolve()
          .then(() => onChange())
          .catch(() => undefined)
      }
      boundary = buffer.search(/\r?\n\r?\n/)
    }
    return "continue"
  }

  armStaleWatch()

  const onAbort = () => {
    clearStaleWatch()
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", onAbort, { once: true })

  try {
    while (true) {
      throwIfStaleOrAborted()

      let done = false
      let value: Uint8Array | undefined
      try {
        ;({ done, value } = await reader.read())
      } catch (error) {
        // Prefer stale over cancel rejections from some runtimes.
        if (staleError !== undefined) throw staleError
        throw error
      }
      // Cancel-for-stale typically resolves read() with done; surface stale first.
      throwIfStaleOrAborted()

      if (value !== undefined && value.byteLength > 0) {
        noteActivity("chunk")
        buffer += decoder.decode(value, { stream: !done })
      }

      if (done) {
        // Flush any multi-byte sequence held by the decoder, then drain frames.
        buffer += decoder.decode()
        if (drainFrames() === "complete") return "complete"
        return "stream_ended"
      }

      if (drainFrames() === "complete") return "complete"
    }
  } finally {
    clearStaleWatch()
    signal.removeEventListener("abort", onAbort)
    try {
      reader.releaseLock()
    } catch {
      // Already canceled or released.
    }
  }
}
