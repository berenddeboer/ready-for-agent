import { generateSubscriptionOp } from "@ready-for-agent/graphql-client"

export const parseWorkItemsSubscriptionEvent = (
  event: string,
): string | null => {
  let eventType = "message"
  const data: string[] = []

  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim()
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }

  if (eventType === "complete") return null
  if (eventType !== "next" && eventType !== "message") return null
  if (data.length === 0) return null

  const result = JSON.parse(data.join("\n")) as {
    data?: { repositoryWorkItemsChanged?: string }
    errors?: unknown
  }
  if (result.errors !== undefined) {
    throw new Error("Work Item change subscription failed")
  }
  return result.data?.repositoryWorkItemsChanged ?? null
}

export const streamWorkItemsChanged = async ({
  signal,
  onConnected,
  onChange,
  fetch: fetchRequest = fetch,
}: {
  signal: AbortSignal
  onConnected: () => void | Promise<void>
  onChange: (repositoryId: string) => void | Promise<void>
  fetch?: typeof fetch
}): Promise<void> => {
  const operation = generateSubscriptionOp({
    repositoryWorkItemsChanged: true,
  })

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
    throw new Error(`Work Item change subscription returned ${response.status}`)
  }

  await onConnected()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })

    let boundary = buffer.search(/\r?\n\r?\n/)
    while (boundary >= 0) {
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0]
      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + (separator?.length ?? 2))

      if (event.startsWith("event: complete")) return
      const repositoryId = parseWorkItemsSubscriptionEvent(event)
      if (repositoryId !== null) await onChange(repositoryId)
      boundary = buffer.search(/\r?\n\r?\n/)
    }

    if (done) return
  }
}
