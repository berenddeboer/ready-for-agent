import type { AgentBackendDescriptor } from "./types.js"

export const AGENT_TURN_TAIL_ITEM_LIMIT = 20
export const AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX = 2000

export type AgentTurnTailAvailability =
  | "available"
  | "missing"
  | "unavailable"
  | "unsupported"

export type AgentTurnTailSourceEvent =
  | { readonly kind: "user"; readonly at: string }
  | {
      readonly kind: "assistant_text"
      readonly text: string
      readonly at: string
    }
  | {
      readonly kind: "tool"
      readonly name: string
      readonly status: string
      readonly at: string
    }

export type AgentTurnTailItem =
  | {
      readonly kind: "assistant_text"
      readonly text: string
      readonly truncated: boolean
      readonly at: string
    }
  | {
      readonly kind: "tool"
      readonly name: string
      readonly status: string
      readonly at: string
    }

export type AgentTurnTail = {
  readonly availability: AgentTurnTailAvailability
  readonly backend: AgentBackendDescriptor
  readonly items: ReadonlyArray<AgentTurnTailItem>
  readonly jumpHint: boolean
}

const lastUserIndex = (
  events: ReadonlyArray<AgentTurnTailSourceEvent>,
): number => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === "user") {
      return index
    }
  }
  return -1
}

const toItem = (
  event: Exclude<AgentTurnTailSourceEvent, { readonly kind: "user" }>,
): AgentTurnTailItem => {
  if (event.kind === "tool") {
    return {
      kind: "tool",
      name: event.name,
      status: event.status,
      at: event.at,
    }
  }
  const truncated = event.text.length > AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX
  return {
    kind: "assistant_text",
    text: truncated
      ? event.text.slice(0, AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX)
      : event.text,
    truncated,
    at: event.at,
  }
}

export const selectAgentTurnTail = (
  events: ReadonlyArray<AgentTurnTailSourceEvent>,
): ReadonlyArray<AgentTurnTailItem> => {
  const boundary = lastUserIndex(events)
  const turn = events.slice(boundary + 1)
  const items: AgentTurnTailItem[] = []
  for (const event of turn) {
    if (event.kind === "user") {
      continue
    }
    items.push(toItem(event))
  }
  return items.slice(-AGENT_TURN_TAIL_ITEM_LIMIT)
}

export const makeAgentTurnTail = (input: {
  readonly availability: AgentTurnTailAvailability
  readonly backend: AgentBackendDescriptor
  readonly items: ReadonlyArray<AgentTurnTailItem>
}): AgentTurnTail => ({
  availability: input.availability,
  backend: input.backend,
  items: input.items,
  jumpHint: input.availability === "available" && input.items.length === 0,
})

export const unsupportedAgentTurnTail = (
  backend: AgentBackendDescriptor,
): AgentTurnTail =>
  makeAgentTurnTail({
    availability: "unsupported",
    backend,
    items: [],
  })

export const missingAgentTurnTail = (
  backend: AgentBackendDescriptor,
): AgentTurnTail =>
  makeAgentTurnTail({
    availability: "missing",
    backend,
    items: [],
  })

export const unavailableAgentTurnTail = (
  backend: AgentBackendDescriptor,
): AgentTurnTail =>
  makeAgentTurnTail({
    availability: "unavailable",
    backend,
    items: [],
  })
