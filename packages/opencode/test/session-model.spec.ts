import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reassertOpencodeSessionModel } from "../src/lib/session-model.js"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"

const createSessionDb = (
  dir: string,
  model: {
    readonly id: string
    readonly providerID: string
    readonly variant: string | null
  },
): string => {
  const path = join(dir, "opencode.db")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      model text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )
  `)
  db.query(
    `INSERT INTO session (id, model, time_created, time_updated) VALUES (?, ?, ?, ?)`,
  ).run(
    "ses_live",
    JSON.stringify(model),
    Date.parse("2026-08-27T22:00:00.000Z"),
    Date.parse("2026-08-27T22:00:00.000Z"),
  )
  db.close()
  return path
}

const readModel = (dbPath: string): unknown => {
  const db = new Database(dbPath, { readonly: true })
  const row = db
    .query(`SELECT model FROM session WHERE id = ?`)
    .get("ses_live") as { readonly model: string }
  db.close()
  return JSON.parse(row.model)
}

describe("reassertOpencodeSessionModel", () => {
  test("rewrites a hijacked Session model back to the configured Agent Model", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-model-"))
    try {
      const dbPath = createSessionDb(dir, {
        id: "gpt-5.6-sol",
        providerID: "azure",
        variant: null,
      })

      expect(
        reassertOpencodeSessionModel({
          dbPath,
          sessionId: "ses_live",
          model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
          thinkingLevel: "high",
        }),
      ).toEqual({
        kind: "rewritten",
        previousModel: "azure/gpt-5.6-sol",
      })
      expect(readModel(dbPath)).toEqual({
        id: "au.anthropic.claude-sonnet-5",
        providerID: "amazon-bedrock",
        variant: "high",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not clear OpenCode's default variant when Thinking Level is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-model-"))
    try {
      const dbPath = createSessionDb(dir, {
        id: "au.anthropic.claude-sonnet-5",
        providerID: "amazon-bedrock",
        variant: "medium",
      })

      expect(
        reassertOpencodeSessionModel({
          dbPath,
          sessionId: "ses_live",
          model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
          thinkingLevel: null,
        }),
      ).toEqual({ kind: "unchanged" })
      expect(readModel(dbPath)).toEqual({
        id: "au.anthropic.claude-sonnet-5",
        providerID: "amazon-bedrock",
        variant: "medium",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("restores a hijacked model without writing a null variant", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-model-"))
    try {
      const dbPath = createSessionDb(dir, {
        id: "gpt-5.6-sol",
        providerID: "azure",
        variant: "xhigh",
      })

      expect(
        reassertOpencodeSessionModel({
          dbPath,
          sessionId: "ses_live",
          model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
          thinkingLevel: null,
        }),
      ).toEqual({
        kind: "rewritten",
        previousModel: "azure/gpt-5.6-sol",
      })
      expect(readModel(dbPath)).toEqual({
        id: "au.anthropic.claude-sonnet-5",
        providerID: "amazon-bedrock",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("leaves a matching Session model unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-model-"))
    try {
      const dbPath = createSessionDb(dir, {
        id: "au.anthropic.claude-sonnet-5",
        providerID: "amazon-bedrock",
        variant: "high",
      })

      expect(
        reassertOpencodeSessionModel({
          dbPath,
          sessionId: "ses_live",
          model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
          thinkingLevel: "high",
        }),
      ).toEqual({ kind: "unchanged" })
      expect(readModel(dbPath)).toEqual({
        id: "au.anthropic.claude-sonnet-5",
        providerID: "amazon-bedrock",
        variant: "high",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns missing when the Session row is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-model-"))
    try {
      const dbPath = createSessionDb(dir, {
        id: "gpt-5.6-sol",
        providerID: "azure",
        variant: null,
      })
      expect(
        reassertOpencodeSessionModel({
          dbPath,
          sessionId: "ses_gone",
          model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
          thinkingLevel: null,
        }),
      ).toEqual({ kind: "missing" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
