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
