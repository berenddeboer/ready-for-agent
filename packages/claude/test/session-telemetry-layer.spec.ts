import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SessionTelemetryProvider } from "@ready-for-agent/agent-backend"
import { ClaudeSessionTelemetryLive } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("ClaudeSessionTelemetryLive", () => {
  const getSession = (input: {
    readonly claudeConfigDir: string
    readonly sessionId: string
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SessionTelemetryProvider
        return yield* provider.getSession(input.sessionId)
      }).pipe(
        Effect.provide(
          ClaudeSessionTelemetryLive({
            claudeConfigDir: input.claudeConfigDir,
          }),
        ),
      ),
    )

  const getTail = (input: {
    readonly claudeConfigDir: string
    readonly sessionId: string
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SessionTelemetryProvider
        return yield* provider.getTail(input.sessionId)
      }).pipe(
        Effect.provide(
          ClaudeSessionTelemetryLive({
            claudeConfigDir: input.claudeConfigDir,
          }),
        ),
      ),
    )

  const writeTranscript = (input: {
    readonly claudeConfigDir: string
    readonly sessionId: string
    readonly model: string
    readonly effort: string
  }) => {
    const path = join(
      input.claudeConfigDir,
      "projects",
      "-work-repo",
      `${input.sessionId}.jsonl`,
    )
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-05T04:27:47.143Z",
        effort: input.effort,
        message: {
          model: input.model,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 5,
          },
        },
      }),
    )
  }

  it("maps transcript-store sessions with the static Claude Code label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-telemetry-"))
    try {
      writeTranscript({
        claudeConfigDir: dir,
        sessionId: "anthropic-session",
        model: "claude-sonnet-5",
        effort: "low",
      })
      writeTranscript({
        claudeConfigDir: dir,
        sessionId: "bedrock-session",
        model:
          "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0",
        effort: "medium",
      })

      await expect(
        getSession({ claudeConfigDir: dir, sessionId: "anthropic-session" }),
      ).resolves.toMatchObject({
        id: "anthropic-session",
        availability: "available",
        backend: { id: "claude", label: "Claude Code" },
        model: {
          providerId: "anthropic",
          id: "claude-sonnet-5",
          thinkingLevel: "low",
        },
        tokens: {
          input: 10,
          output: 4,
          reasoning: 0,
          cacheRead: 30,
          cacheWrite: 5,
        },
      })
      await expect(
        getSession({ claudeConfigDir: dir, sessionId: "bedrock-session" }),
      ).resolves.toMatchObject({
        id: "bedrock-session",
        availability: "available",
        backend: { id: "claude", label: "Claude Code" },
        model: {
          providerId: "bedrock",
          thinkingLevel: "medium",
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("serves Agent Turn Tail from the parent transcript only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-telemetry-"))
    try {
      const sessionId = "tail-session"
      const path = join(dir, "projects", "-work-repo", `${sessionId}.jsonl`)
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(
        path,
        [
          JSON.stringify({
            type: "user",
            timestamp: "2026-08-18T12:00:01.000Z",
            isSidechain: false,
            message: { role: "user", content: "implement" },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-08-18T12:00:02.000Z",
            isSidechain: false,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "working" }],
            },
          }),
        ].join("\n"),
      )

      await expect(
        getTail({ claudeConfigDir: dir, sessionId }),
      ).resolves.toEqual({
        availability: "available",
        backend: { id: "claude", label: "Claude Code" },
        jumpHint: false,
        items: [
          {
            kind: "assistant_text",
            text: "working",
            truncated: false,
            at: "2026-08-18T12:00:02.000Z",
          },
        ],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("maps an absent transcript to missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-session-telemetry-"))
    try {
      await expect(
        getSession({ claudeConfigDir: dir, sessionId: "missing-session" }),
      ).resolves.toEqual({
        id: "missing-session",
        availability: "missing",
        backend: { id: "claude", label: "Claude Code" },
        model: null,
        tokens: null,
        cost: null,
        createdAt: null,
        updatedAt: null,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
