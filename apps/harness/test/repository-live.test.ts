import {
  parseSubscriptionEvent,
  streamRepositoryChanges,
} from "../src/repository-live.js"
import { describe, expect, test } from "bun:test"

describe("Repository live updates", () => {
  test("parses GraphQL SSE events", () => {
    expect(
      parseSubscriptionEvent(
        'event: next\ndata: {"data":{"repositoriesChanged":true}}',
      ),
    ).toBe("next")
    expect(parseSubscriptionEvent("event: complete")).toBe("complete")
    expect(parseSubscriptionEvent(": keep-alive")).toBeNull()
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

    expect(connected).toBe(1)
    expect(changes).toBe(2)
  })
})
