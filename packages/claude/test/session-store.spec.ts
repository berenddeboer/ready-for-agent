import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import {
  CLAUDE_BEDROCK_SESSION_PROVIDER_ID,
  CLAUDE_SESSION_PROVIDER_ID,
  ClaudeSessionStore,
  ClaudeSessionStoreLive,
  findClaudeSessionTranscript,
  isSafeClaudeSessionIdSegment,
  resolveClaudeConfigDir,
} from "../src/lib/session-store.js"
import { describe, expect, test } from "bun:test"

const assistantLine = (input: {
  readonly timestamp: string
  readonly model: string
  readonly effort?: string
  readonly usage: Record<string, unknown>
}): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    message: {
      role: "assistant",
      model: input.model,
      usage: input.usage,
    },
  })

const writeTranscript = (input: {
  readonly claudeConfigDir: string
  readonly project: string
  readonly sessionId: string
  readonly jsonl: string
}): string => {
  const path = join(
    input.claudeConfigDir,
    "projects",
    input.project,
    `${input.sessionId}.jsonl`,
  )
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, input.jsonl)
  return path
}

const getSession = async (input: {
  readonly claudeConfigDir: string
  readonly id: string
}) => {
  const runtime = ManagedRuntime.make(
    ClaudeSessionStoreLive({ claudeConfigDir: input.claudeConfigDir }),
  )
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ClaudeSessionStore
        return yield* store.getSession(input.id)
      }),
    )
  } finally {
    await runtime.dispose()
  }
}

const getTail = async (input: {
  readonly claudeConfigDir: string
  readonly id: string
}) => {
  const runtime = ManagedRuntime.make(
    ClaudeSessionStoreLive({ claudeConfigDir: input.claudeConfigDir }),
  )
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ClaudeSessionStore
        return yield* store.getTail(input.id)
      }),
    )
  } finally {
    await runtime.dispose()
  }
}

const userPromptLine = (input: {
  readonly timestamp: string
  readonly text: string
}): string =>
  JSON.stringify({
    type: "user",
    timestamp: input.timestamp,
    isSidechain: false,
    message: { role: "user", content: input.text },
  })

const assistantTextLine = (input: {
  readonly timestamp: string
  readonly text: string
  readonly isSidechain?: boolean
  readonly parentToolUseId?: string
}): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    isSidechain: input.isSidechain ?? false,
    ...(input.parentToolUseId === undefined
      ? {}
      : { parent_tool_use_id: input.parentToolUseId }),
    message: {
      role: "assistant",
      content: [{ type: "text", text: input.text }],
    },
  })

const assistantToolUseLine = (input: {
  readonly timestamp: string
  readonly id: string
  readonly name: string
  readonly command: string
}): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: input.id,
          name: input.name,
          input: { command: input.command },
        },
      ],
    },
  })

const userToolResultLine = (input: {
  readonly timestamp: string
  readonly toolUseId: string
  readonly content: string
  readonly isError?: boolean
}): string =>
  JSON.stringify({
    type: "user",
    timestamp: input.timestamp,
    isSidechain: false,
    message: {
      role: "user",
      content: [
        {
          tool_use_id: input.toolUseId,
          type: "tool_result",
          content: input.content,
          is_error: input.isError ?? false,
        },
      ],
    },
  })

describe("ClaudeSessionStore", () => {
  test("reads real-shaped main and recursive subagent transcripts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      const sessionId = "c2e5a4dd-c069-4d80-9f66-68b49657e70b"
      const mainPath = writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId,
        jsonl: [
          JSON.stringify({
            type: "queue-operation",
            timestamp: "2026-08-05T04:27:43.674Z",
          }),
          assistantLine({
            timestamp: "2026-08-05T04:27:47.143Z",
            model: "claude-haiku-4-5-20251001",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 7106,
              cache_read_input_tokens: 17536,
              output_tokens: 40,
              iterations: [{ type: "message" }],
            },
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-08-05T04:27:48.240Z",
          }),
          '{"type":"assistant"',
        ].join("\n"),
      })
      const subagentPath = join(
        mainPath,
        "..",
        sessionId,
        "subagents",
        "team",
        "worker.jsonl",
      )
      mkdirSync(join(subagentPath, ".."), { recursive: true })
      writeFileSync(
        subagentPath,
        [
          assistantLine({
            timestamp: "2026-08-05T04:27:50.389Z",
            model:
              "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0",
            effort: "medium",
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 9310,
              cache_read_input_tokens: 23684,
              output_tokens: 11,
            },
          }),
          JSON.stringify({
            type: "tool_result",
            timestamp: "2026-08-05T04:27:51.437Z",
          }),
          "not JSON",
        ].join("\n"),
      )

      await expect(
        getSession({ claudeConfigDir: dir, id: `  ${sessionId}  ` }),
      ).resolves.toEqual({
        id: sessionId,
        availability: "available",
        model: {
          providerId: CLAUDE_BEDROCK_SESSION_PROVIDER_ID,
          id: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0",
          thinkingLevel: "medium",
        },
        tokens: {
          input: 12,
          output: 51,
          reasoning: 0,
          cacheRead: 41220,
          cacheWrite: 16416,
        },
        cost: null,
        createdAt: "2026-08-05T04:27:43.674Z",
        updatedAt: "2026-08-05T04:27:51.437Z",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("uses Anthropic for alias model ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "alias-session",
        jsonl: assistantLine({
          timestamp: "2026-08-05T04:27:47.143Z",
          model: "claude-sonnet-5",
          effort: "low",
          usage: {},
        }),
      })

      await expect(
        getSession({ claudeConfigDir: dir, id: "alias-session" }),
      ).resolves.toMatchObject({
        availability: "available",
        model: {
          providerId: CLAUDE_SESSION_PROVIDER_ID,
          id: "claude-sonnet-5",
          thinkingLevel: "low",
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ignores invalid token counts from transcript data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "invalid-token-counts",
        jsonl: assistantLine({
          timestamp: "2026-08-05T04:27:47.143Z",
          model: "claude-sonnet-5",
          usage: {
            input_tokens: -1,
            output_tokens: 1.5,
            cache_read_input_tokens: Number.POSITIVE_INFINITY,
            cache_creation_input_tokens: 2,
          },
        }),
      })

      await expect(
        getSession({ claudeConfigDir: dir, id: "invalid-token-counts" }),
      ).resolves.toMatchObject({
        availability: "available",
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 2,
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("uses the last assistant line even when timestamps are out of order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "out-of-order-model",
        jsonl: [
          assistantLine({
            timestamp: "2026-08-05T04:28:00.000Z",
            model: "claude-sonnet-5",
            effort: "low",
            usage: {},
          }),
          assistantLine({
            timestamp: "2026-08-05T04:27:00.000Z",
            model: "claude-haiku-4-5-20251001",
            effort: "high",
            usage: {},
          }),
        ].join("\n"),
      })

      await expect(
        getSession({ claudeConfigDir: dir, id: "out-of-order-model" }),
      ).resolves.toMatchObject({
        availability: "available",
        model: {
          providerId: CLAUDE_SESSION_PROVIDER_ID,
          id: "claude-haiku-4-5-20251001",
          thinkingLevel: "high",
        },
        createdAt: "2026-08-05T04:27:00.000Z",
        updatedAt: "2026-08-05T04:28:00.000Z",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("uses the latest assistant across multiple subagent transcripts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      const sessionId = "multiple-subagents"
      const mainPath = writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId,
        jsonl: assistantLine({
          timestamp: "2026-08-05T04:27:00.000Z",
          model: "claude-haiku-4-5-20251001",
          usage: {},
        }),
      })
      const subagentsRoot = join(mainPath, "..", sessionId, "subagents")
      mkdirSync(subagentsRoot, { recursive: true })
      writeFileSync(
        join(subagentsRoot, "alpha.jsonl"),
        assistantLine({
          timestamp: "2026-08-05T04:29:00.000Z",
          model: "claude-sonnet-5",
          effort: "high",
          usage: {},
        }),
      )
      writeFileSync(
        join(subagentsRoot, "zeta.jsonl"),
        assistantLine({
          timestamp: "2026-08-05T04:28:00.000Z",
          model: "claude-opus-4-5-20251101",
          usage: {},
        }),
      )

      await expect(
        getSession({ claudeConfigDir: dir, id: sessionId }),
      ).resolves.toMatchObject({
        availability: "available",
        model: {
          providerId: CLAUDE_SESSION_PROVIDER_ID,
          id: "claude-sonnet-5",
          thinkingLevel: "high",
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns missing for absent and foreign sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-other-project",
        sessionId: "foreign-session",
        jsonl: "",
      })
      await expect(
        getSession({ claudeConfigDir: dir, id: "wanted-session" }),
      ).resolves.toMatchObject({
        id: "wanted-session",
        availability: "missing",
        model: null,
        tokens: null,
        cost: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns unavailable for ambiguous project attribution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-project-a",
        sessionId: "duplicated-session",
        jsonl: "",
      })
      writeTranscript({
        claudeConfigDir: dir,
        project: "-project-b",
        sessionId: "duplicated-session",
        jsonl: "",
      })
      await expect(
        getSession({ claudeConfigDir: dir, id: "duplicated-session" }),
      ).resolves.toMatchObject({
        availability: "unavailable",
        model: null,
        tokens: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns unavailable when the projects root cannot be read as a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeFileSync(join(dir, "projects"), "not a directory")
      await expect(
        getSession({ claudeConfigDir: dir, id: "session" }),
      ).resolves.toMatchObject({
        availability: "unavailable",
        tokens: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns unavailable for a malformed matching transcript node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      mkdirSync(join(dir, "projects", "-work-repo", "corrupt-session.jsonl"), {
        recursive: true,
      })

      await expect(
        getSession({ claudeConfigDir: dir, id: "corrupt-session" }),
      ).resolves.toMatchObject({
        availability: "unavailable",
        tokens: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns unavailable for a corrupt subagents root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      const mainPath = writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "session-with-bad-subagents",
        jsonl: "",
      })
      mkdirSync(join(mainPath, "..", "session-with-bad-subagents"), {
        recursive: true,
      })
      writeFileSync(
        join(mainPath, "..", "session-with-bad-subagents", "subagents"),
        "not a directory",
      )

      await expect(
        getSession({ claudeConfigDir: dir, id: "session-with-bad-subagents" }),
      ).resolves.toMatchObject({
        availability: "unavailable",
        tokens: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns unavailable for a corrupt nested subagent transcript node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      const sessionId = "session-with-bad-subagent"
      const mainPath = writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId,
        jsonl: "",
      })
      mkdirSync(join(mainPath, "..", sessionId, "subagents", "worker.jsonl"), {
        recursive: true,
      })

      await expect(
        getSession({ claudeConfigDir: dir, id: sessionId }),
      ).resolves.toMatchObject({
        availability: "unavailable",
        tokens: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reads the latest Agent Turn Tail without tool payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    const payload = "PAYLOAD_MUST_NOT_APPEAR".repeat(200)
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "tail-session",
        jsonl: [
          userPromptLine({
            timestamp: "2026-08-18T12:00:01.000Z",
            text: "old harness prompt",
          }),
          assistantTextLine({
            timestamp: "2026-08-18T12:00:02.000Z",
            text: "old turn",
          }),
          assistantToolUseLine({
            timestamp: "2026-08-18T12:00:03.000Z",
            id: "toolu_old",
            name: "Read",
            command: payload,
          }),
          userToolResultLine({
            timestamp: "2026-08-18T12:00:03.500Z",
            toolUseId: "toolu_old",
            content: payload,
          }),
          userPromptLine({
            timestamp: "2026-08-18T12:00:04.000Z",
            text: "Implement GitHub issue #1145.",
          }),
          assistantToolUseLine({
            timestamp: "2026-08-18T12:00:05.000Z",
            id: "toolu_test",
            name: "Bash",
            command: "bun test",
          }),
          userToolResultLine({
            timestamp: "2026-08-18T12:00:05.500Z",
            toolUseId: "toolu_test",
            content: payload,
            isError: true,
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-08-18T12:00:06.000Z",
            isSidechain: false,
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: payload },
                { type: "text", text: "tests failed" },
              ],
            },
          }),
        ].join("\n"),
      })

      const tail = await getTail({
        claudeConfigDir: dir,
        id: "  tail-session  ",
      })
      expect(tail).toEqual({
        availability: "available",
        backend: { id: "claude", label: "Claude Code" },
        jumpHint: false,
        items: [
          {
            kind: "tool",
            name: "Bash",
            status: "failed",
            at: "2026-08-18T12:00:05.000Z",
          },
          {
            kind: "assistant_text",
            text: "tests failed",
            truncated: false,
            at: "2026-08-18T12:00:06.000Z",
          },
        ],
      })
      expect(JSON.stringify(tail)).not.toContain("PAYLOAD_MUST_NOT_APPEAR")
      expect(JSON.stringify(tail)).not.toContain("bun test")
      expect(JSON.stringify(tail)).not.toContain("old harness prompt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns empty tail with jumpHint when the latest turn has no activity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "empty-turn",
        jsonl: [
          userPromptLine({
            timestamp: "2026-08-18T12:00:01.000Z",
            text: "implement",
          }),
          assistantTextLine({
            timestamp: "2026-08-18T12:00:02.000Z",
            text: "done",
          }),
          userPromptLine({
            timestamp: "2026-08-18T12:00:03.000Z",
            text: "review in children",
          }),
        ].join("\n"),
      })

      const tail = await getTail({
        claudeConfigDir: dir,
        id: "empty-turn",
      })
      expect(tail.availability).toBe("available")
      expect(tail.items).toEqual([])
      expect(tail.jumpHint).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns the last 20 activity items of the latest turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      const lines = [
        userPromptLine({
          timestamp: "2026-08-18T12:00:00.000Z",
          text: "implement",
        }),
      ]
      for (let index = 1; index <= 25; index += 1) {
        const second = String(index).padStart(2, "0")
        lines.push(
          assistantToolUseLine({
            timestamp: `2026-08-18T12:00:${second}.000Z`,
            id: `toolu_${index}`,
            name: `tool-${index}`,
            command: "secret-arg",
          }),
          userToolResultLine({
            timestamp: `2026-08-18T12:00:${second}.500Z`,
            toolUseId: `toolu_${index}`,
            content: "secret-output",
          }),
        )
      }
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "long-turn",
        jsonl: lines.join("\n"),
      })

      const tail = await getTail({
        claudeConfigDir: dir,
        id: "long-turn",
      })
      expect(tail.items).toHaveLength(20)
      expect(tail.items[0]).toEqual({
        kind: "tool",
        name: "tool-6",
        status: "completed",
        at: "2026-08-18T12:00:06.000Z",
      })
      expect(tail.items[19]).toEqual({
        kind: "tool",
        name: "tool-25",
        status: "completed",
        at: "2026-08-18T12:00:25.000Z",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("truncates assistant text at 2k characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "long-text",
        jsonl: [
          userPromptLine({
            timestamp: "2026-08-18T12:00:01.000Z",
            text: "summarize",
          }),
          assistantTextLine({
            timestamp: "2026-08-18T12:00:02.000Z",
            text: "a".repeat(2050),
          }),
        ].join("\n"),
      })

      await expect(
        getTail({ claudeConfigDir: dir, id: "long-text" }),
      ).resolves.toMatchObject({
        availability: "available",
        items: [
          {
            kind: "assistant_text",
            text: "a".repeat(2000),
            truncated: true,
            at: "2026-08-18T12:00:02.000Z",
          },
        ],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not include child Session or subagent activity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      const mainPath = writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "parent-session",
        jsonl: [
          userPromptLine({
            timestamp: "2026-08-18T12:00:01.000Z",
            text: "implement",
          }),
          assistantTextLine({
            timestamp: "2026-08-18T12:00:02.000Z",
            text: "parent done",
          }),
          userPromptLine({
            timestamp: "2026-08-18T12:00:03.000Z",
            text: "review in children",
          }),
          assistantTextLine({
            timestamp: "2026-08-18T12:00:04.000Z",
            text: "sidechain leak",
            isSidechain: true,
          }),
          assistantTextLine({
            timestamp: "2026-08-18T12:00:05.000Z",
            text: "nested subagent leak",
            parentToolUseId: "toolu_parent",
          }),
        ].join("\n"),
      })
      const subagentPath = join(
        mainPath,
        "..",
        "parent-session",
        "subagents",
        "worker.jsonl",
      )
      mkdirSync(join(subagentPath, ".."), { recursive: true })
      writeFileSync(
        subagentPath,
        assistantTextLine({
          timestamp: "2026-08-18T12:00:06.000Z",
          text: "child is reviewing",
          isSidechain: true,
        }),
      )

      const tail = await getTail({
        claudeConfigDir: dir,
        id: "parent-session",
      })
      expect(tail).toEqual({
        availability: "available",
        backend: { id: "claude", label: "Claude Code" },
        jumpHint: true,
        items: [],
      })
      expect(JSON.stringify(tail)).not.toContain("child is reviewing")
      expect(JSON.stringify(tail)).not.toContain("sidechain leak")
      expect(JSON.stringify(tail)).not.toContain("nested subagent leak")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps MISSING and UNAVAILABLE instead of failing the tail read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-other-project",
        sessionId: "foreign-session",
        jsonl: "",
      })
      await expect(
        getTail({ claudeConfigDir: dir, id: "wanted-session" }),
      ).resolves.toEqual({
        availability: "missing",
        backend: { id: "claude", label: "Claude Code" },
        items: [],
        jumpHint: false,
      })

      writeTranscript({
        claudeConfigDir: dir,
        project: "-project-a",
        sessionId: "duplicated-session",
        jsonl: "",
      })
      writeTranscript({
        claudeConfigDir: dir,
        project: "-project-b",
        sessionId: "duplicated-session",
        jsonl: "",
      })
      await expect(
        getTail({ claudeConfigDir: dir, id: "duplicated-session" }),
      ).resolves.toEqual({
        availability: "unavailable",
        backend: { id: "claude", label: "Claude Code" },
        items: [],
        jumpHint: false,
      })

      mkdirSync(join(dir, "projects", "-work-repo", "corrupt-session.jsonl"), {
        recursive: true,
      })
      await expect(
        getTail({ claudeConfigDir: dir, id: "corrupt-session" }),
      ).resolves.toEqual({
        availability: "unavailable",
        backend: { id: "claude", label: "Claude Code" },
        items: [],
        jumpHint: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reads Session token usage without fetching the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      const sessionId = "usage-without-tail"
      const mainPath = writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId,
        jsonl: [
          assistantLine({
            timestamp: "2026-08-18T12:00:01.000Z",
            model: "claude-sonnet-5",
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 5,
            },
          }),
          userPromptLine({
            timestamp: "2026-08-18T12:00:02.000Z",
            text: "review in children",
          }),
        ].join("\n"),
      })
      const subagentPath = join(
        mainPath,
        "..",
        sessionId,
        "subagents",
        "worker.jsonl",
      )
      mkdirSync(join(subagentPath, ".."), { recursive: true })
      writeFileSync(
        subagentPath,
        assistantLine({
          timestamp: "2026-08-18T12:00:03.000Z",
          model: "claude-haiku-4-5-20251001",
          usage: {
            input_tokens: 2,
            output_tokens: 11,
          },
        }),
      )

      const session = await getSession({ claudeConfigDir: dir, id: sessionId })
      expect(session).toMatchObject({
        availability: "available",
        tokens: {
          input: 12,
          output: 15,
          reasoning: 0,
          cacheRead: 30,
          cacheWrite: 5,
        },
      })
      await expect(
        getTail({ claudeConfigDir: dir, id: sessionId }),
      ).resolves.toMatchObject({
        availability: "available",
        items: [],
        jumpHint: true,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Claude transcript lookup", () => {
  test("resolves CLAUDE_CONFIG_DIR before HOME and defaults to ~/.claude", () => {
    expect(
      resolveClaudeConfigDir({
        env: { CLAUDE_CONFIG_DIR: " /configured/claude ", HOME: "/home/env" },
        home: "/home/override",
      }),
    ).toBe("/configured/claude")
    expect(resolveClaudeConfigDir({ env: { HOME: "/home/env" } })).toBe(
      "/home/env/.claude",
    )
  })

  test("rejects path escapes and finds a trimmed opaque session id", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        project: "-work-repo",
        sessionId: "safe-session",
        jsonl: "",
      })
      expect(isSafeClaudeSessionIdSegment("safe-session")).toBe(true)
      expect(isSafeClaudeSessionIdSegment("abc..def")).toBe(true)
      for (const id of [
        "",
        ".",
        "..",
        "../escape",
        "a/b",
        "a\\b",
        "/etc/passwd",
      ]) {
        expect(isSafeClaudeSessionIdSegment(id)).toBe(false)
        expect(
          findClaudeSessionTranscript({ claudeConfigDir: dir, sessionId: id }),
        ).toEqual({
          kind: "missing",
        })
      }
      expect(
        findClaudeSessionTranscript({
          claudeConfigDir: dir,
          sessionId: "  safe-session  ",
        }),
      ).toEqual({
        kind: "found",
        path: join(dir, "projects", "-work-repo", "safe-session.jsonl"),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
