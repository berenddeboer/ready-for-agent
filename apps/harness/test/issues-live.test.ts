import {
  parseIssuesSubscriptionEvent,
  streamIssuesChanged,
} from "../src/issues-live.js"
import { describe, expect, test } from "bun:test"

describe("Issue live updates", () => {
  test("parses GraphQL SSE events", () => {
    expect(
      parseIssuesSubscriptionEvent(
        'event: next\ndata: {"data":{"repositoryIssuesChanged":"repo-1"}}',
      ),
    ).toBe("repo-1")
    expect(parseIssuesSubscriptionEvent("event: complete")).toBeNull()
    expect(parseIssuesSubscriptionEvent(": keep-alive")).toBeNull()
  })

  test("connects once and reports each changed Repository", async () => {
    const events = [
      'event: next\ndata: {"data":{"repositoryIssuesChanged":"repo-1"}}\n\n',
      'event: next\ndata: {"data":{"repositoryIssuesChanged":"repo-2"}}\n\n',
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
    const changes: string[] = []
    let requestedBody: string | undefined

    await streamIssuesChanged({
      signal: new AbortController().signal,
      onConnected: () => {
        connected += 1
      },
      onChange: (repositoryId) => {
        changes.push(repositoryId)
      },
      fetch: (_url, init) => {
        requestedBody = String(init?.body)
        return Promise.resolve(new Response(body, { status: 200 }))
      },
    })

    expect(connected).toBe(1)
    expect(changes).toEqual(["repo-1", "repo-2"])
    expect(requestedBody).toContain("repositoryIssuesChanged")
  })
})
