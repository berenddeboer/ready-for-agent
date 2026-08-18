import {
  AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX,
  AGENT_TURN_TAIL_ITEM_LIMIT,
  makeAgentTurnTail,
  selectAgentTurnTail,
} from "../src/lib/agent-turn-tail.js"
import { describe, expect, test } from "bun:test"

const at = (second: number): string =>
  `2026-08-18T12:00:${String(second).padStart(2, "0")}.000Z`

describe("selectAgentTurnTail", () => {
  test("keeps only activity after the last user event", () => {
    expect(
      selectAgentTurnTail([
        { kind: "user", at: at(1) },
        { kind: "assistant_text", text: "old turn", at: at(2) },
        { kind: "tool", name: "read", status: "completed", at: at(3) },
        { kind: "user", at: at(4) },
        { kind: "tool", name: "bun test", status: "failed", at: at(5) },
        { kind: "assistant_text", text: "tests failed", at: at(6) },
      ]),
    ).toEqual([
      {
        kind: "tool",
        name: "bun test",
        status: "failed",
        at: at(5),
      },
      {
        kind: "assistant_text",
        text: "tests failed",
        truncated: false,
        at: at(6),
      },
    ])
  })

  test("returns the last 20 activity items of the latest turn", () => {
    const events = [
      { kind: "user" as const, at: at(0) },
      ...Array.from({ length: 25 }, (_, index) => ({
        kind: "tool" as const,
        name: `tool-${index + 1}`,
        status: "completed",
        at: at(index + 1),
      })),
    ]
    const items = selectAgentTurnTail(events)
    expect(items).toHaveLength(AGENT_TURN_TAIL_ITEM_LIMIT)
    expect(items[0]).toEqual({
      kind: "tool",
      name: "tool-6",
      status: "completed",
      at: at(6),
    })
    expect(items[19]).toEqual({
      kind: "tool",
      name: "tool-25",
      status: "completed",
      at: at(25),
    })
  })

  test("truncates assistant text at 2k characters", () => {
    const text = "a".repeat(AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX + 50)
    expect(
      selectAgentTurnTail([
        { kind: "user", at: at(1) },
        { kind: "assistant_text", text, at: at(2) },
      ]),
    ).toEqual([
      {
        kind: "assistant_text",
        text: "a".repeat(AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX),
        truncated: true,
        at: at(2),
      },
    ])
  })

  test("returns no items when the latest turn has no activity", () => {
    expect(
      selectAgentTurnTail([
        { kind: "user", at: at(1) },
        { kind: "assistant_text", text: "done", at: at(2) },
        { kind: "user", at: at(3) },
      ]),
    ).toEqual([])
  })

  test("uses the whole stream when there is no user boundary", () => {
    expect(
      selectAgentTurnTail([
        { kind: "tool", name: "ls", status: "completed", at: at(1) },
        { kind: "assistant_text", text: "listed", at: at(2) },
      ]),
    ).toEqual([
      { kind: "tool", name: "ls", status: "completed", at: at(1) },
      {
        kind: "assistant_text",
        text: "listed",
        truncated: false,
        at: at(2),
      },
    ])
  })
})

describe("makeAgentTurnTail", () => {
  const backend = { id: "opencode", label: "OpenCode" } as const

  test("sets jumpHint when the latest turn is empty", () => {
    expect(
      makeAgentTurnTail({
        availability: "available",
        backend,
        items: [],
      }),
    ).toEqual({
      availability: "available",
      backend,
      items: [],
      jumpHint: true,
    })
  })

  test("does not set jumpHint when items exist", () => {
    expect(
      makeAgentTurnTail({
        availability: "available",
        backend,
        items: [
          {
            kind: "tool",
            name: "ls",
            status: "completed",
            at: at(1),
          },
        ],
      }).jumpHint,
    ).toBe(false)
  })
})
