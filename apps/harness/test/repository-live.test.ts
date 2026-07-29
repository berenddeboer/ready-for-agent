import {
  REPOSITORY_SSE_HEARTBEAT_INTERVAL_MS,
  REPOSITORY_SSE_STALE_AFTER_MS,
  RepositorySubscriptionStaleError,
  parseSubscriptionEvent,
  streamRepositoryChanges,
} from "../src/repository-live.js"
import { describe, expect, test } from "bun:test"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Repository live updates", () => {
  test("documents a stale bound longer than Yoga's production heartbeat", () => {
    expect(REPOSITORY_SSE_HEARTBEAT_INTERVAL_MS).toBe(12_000)
    expect(REPOSITORY_SSE_STALE_AFTER_MS).toBeGreaterThan(
      REPOSITORY_SSE_HEARTBEAT_INTERVAL_MS,
    )
  })

  test("parses GraphQL SSE events and Yoga heartbeat comments", () => {
    expect(
      parseSubscriptionEvent(
        'event: next\ndata: {"data":{"repositoriesChanged":true}}',
      ),
    ).toBe("next")
    expect(parseSubscriptionEvent("event: complete")).toBe("complete")
    expect(parseSubscriptionEvent(": keep-alive")).toBe("comment")
    expect(parseSubscriptionEvent(":")).toBe("comment")
  })

  test("connects and reports every change event", async () => {
    const events = [
      'event: next\ndata: {"data":{"repositoriesChanged":true}}\n\n',
      'event: next\ndata: {"data":{"repositoriesChanged":true}}\n\n',
      "event: complete\n\n",
    ]
    const body = new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(new TextEncoder().encode(event))
        controller.close()
      },
    })
    let connected = 0
    let changes = 0

    await streamRepositoryChanges({
      signal: new AbortController().signal,
      onConnected: () => {
        connected += 1
      },
      onChange: () => {
        changes += 1
      },
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    })

    // onChange is fire-and-forget; allow microtasks to settle.
    await wait(0)
    expect(connected).toBe(1)
    expect(changes).toBe(2)
  })

  test("reports transport ready before catch-up finishes and keeps reading", async () => {
    const encoder = new TextEncoder()
    let releaseCatchUp: (() => void) | undefined
    const catchUpGate = new Promise<void>((resolve) => {
      releaseCatchUp = resolve
    })
    let pushEvent: ((chunk: string) => void) | undefined
    let closeStream: (() => void) | undefined

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        pushEvent = (chunk) => controller.enqueue(encoder.encode(chunk))
        closeStream = () => controller.close()
      },
    })

    let connectedAt: number | undefined
    let firstChangeAt: number | undefined
    let catchUpStartedAt: number | undefined
    let catchUpFinished = false
    const activities: string[] = []

    const streamDone = streamRepositoryChanges({
      signal: new AbortController().signal,
      staleAfterMs: Number.POSITIVE_INFINITY,
      onConnected: async () => {
        connectedAt = Date.now()
        catchUpStartedAt = Date.now()
        await catchUpGate
        catchUpFinished = true
      },
      onChange: () => {
        firstChangeAt = Date.now()
      },
      onActivity: ({ kind }) => {
        activities.push(kind)
      },
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    })

    // Transport ready must fire without waiting for catch-up.
    await wait(10)
    expect(connectedAt).toBeDefined()
    expect(catchUpStartedAt).toBeDefined()
    expect(catchUpFinished).toBe(false)

    // Heartbeats and notifications must be observed while catch-up is held.
    pushEvent?.(": keep-alive\n\n")
    pushEvent?.('event: next\ndata: {"data":{"repositoriesChanged":true}}\n\n')
    await wait(20)

    expect(catchUpFinished).toBe(false)
    expect(activities).toContain("comment")
    expect(activities).toContain("next")
    expect(firstChangeAt).toBeDefined()

    releaseCatchUp?.()
    pushEvent?.("event: complete\n\n")
    closeStream?.()
    await streamDone
    expect(catchUpFinished).toBe(true)
  })

  test("a failed catch-up does not terminate an otherwise healthy stream", async () => {
    const encoder = new TextEncoder()
    let pushEvent: ((chunk: string) => void) | undefined
    let closeStream: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        pushEvent = (chunk) => controller.enqueue(encoder.encode(chunk))
        closeStream = () => controller.close()
      },
    })

    let changes = 0
    const streamDone = streamRepositoryChanges({
      signal: new AbortController().signal,
      staleAfterMs: Number.POSITIVE_INFINITY,
      onConnected: async () => {
        throw new Error("catch-up blew up")
      },
      onChange: () => {
        changes += 1
      },
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    })

    await wait(10)
    pushEvent?.('event: next\ndata: {"data":{"repositoriesChanged":true}}\n\n')
    await wait(10)
    expect(changes).toBe(1)

    pushEvent?.("event: complete\n\n")
    closeStream?.()
    await streamDone
  })

  test("marks a quiet connection stale after the activity bound", async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue activity after open.
      },
      cancel() {
        // Reader cancel on stale is expected.
      },
    })

    let staleError: unknown
    try {
      await streamRepositoryChanges({
        signal: new AbortController().signal,
        staleAfterMs: 30,
        onConnected: () => undefined,
        onChange: () => undefined,
        fetch: () => Promise.resolve(new Response(body, { status: 200 })),
      })
    } catch (error) {
      staleError = error
    }

    expect(staleError).toBeInstanceOf(RepositorySubscriptionStaleError)
  })

  test("decodes a final chunk delivered with done and flushes the decoder", async () => {
    const encoder = new TextEncoder()
    // Deliver the last event in the same read that signals done (value + done).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: next\ndata: {"data":{"repositoriesChanged":true}}\n\n',
          ),
        )
        controller.close()
      },
    })

    let changes = 0
    const end = await streamRepositoryChanges({
      signal: new AbortController().signal,
      staleAfterMs: Number.POSITIVE_INFINITY,
      onConnected: () => undefined,
      onChange: () => {
        changes += 1
      },
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    })
    await wait(0)
    expect(changes).toBe(1)
    expect(end).toBe("stream_ended")
  })

  test("returns complete when the subscription emits event: complete", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: complete\n\n"))
        controller.close()
      },
    })
    const end = await streamRepositoryChanges({
      signal: new AbortController().signal,
      staleAfterMs: Number.POSITIVE_INFINITY,
      onConnected: () => undefined,
      onChange: () => undefined,
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    })
    expect(end).toBe("complete")
  })

  test("prefers stale over a rejecting reader cancel", async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Hang open until cancel.
      },
      cancel() {
        // Some hosts reject outstanding reads; the streamer must still surface stale.
      },
    })
    // Monkey-patch getReader to reject after cancel.
    const response = new Response(body, { status: 200 })
    const originalGetReader = response.body!.getReader.bind(response.body)
    response.body!.getReader = () => {
      const reader = originalGetReader()
      const originalRead = reader.read.bind(reader)
      let cancelled = false
      const originalCancel = reader.cancel.bind(reader)
      reader.cancel = async (reason?: unknown) => {
        cancelled = true
        return originalCancel(reason)
      }
      reader.read = (async () => {
        if (cancelled) throw new Error("read rejected after cancel")
        return originalRead()
      }) as typeof reader.read
      return reader
    }

    let staleError: unknown
    try {
      await streamRepositoryChanges({
        signal: new AbortController().signal,
        staleAfterMs: 20,
        onConnected: () => undefined,
        onChange: () => undefined,
        fetch: () => Promise.resolve(response),
      })
    } catch (error) {
      staleError = error
    }
    expect(staleError).toBeInstanceOf(RepositorySubscriptionStaleError)
  })
})
