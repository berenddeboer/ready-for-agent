import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  peekSelectedAgentBackendId,
  peekSelectedAgentBackendIds,
} from "./peek-selected-agent-backend.ts"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"

const createTempDb = (): { readonly path: string; readonly root: string } => {
  const root = mkdtempSync(join(tmpdir(), "rfa-peek-backend-"))
  return { path: join(root, "ready-for-agent.db"), root }
}

const openWritable = (path: string): Database =>
  new Database(path, { create: true })

const ensureConfigTable = (db: Database): void => {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      selected_agent_backend TEXT NOT NULL DEFAULT 'opencode'
    )
  `)
}

const ensureRepositoryTable = (db: Database): void => {
  db.run(`
    CREATE TABLE IF NOT EXISTS repository (
      id TEXT PRIMARY KEY,
      selected_agent_backend TEXT
    )
  `)
}

describe("peekSelectedAgentBackendIds", () => {
  let roots: string[] = []

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
    roots = []
  })

  test("missing DB defaults safely to OpenCode only", () => {
    expect(
      peekSelectedAgentBackendIds("/no/such/path/ready-for-agent.db"),
    ).toEqual(["opencode"])
    expect(peekSelectedAgentBackendIds(":memory:")).toEqual(["opencode"])
    expect(peekSelectedAgentBackendIds("")).toEqual(["opencode"])
  })

  test("default only when no repository overrides", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = openWritable(path)
    try {
      ensureConfigTable(db)
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO config (id, selected_agent_backend) VALUES ('default', 'opencode')`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-1', NULL)`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-2', NULL)`,
      )
    } finally {
      db.close()
    }

    expect(peekSelectedAgentBackendIds(path)).toEqual(["opencode"])
    expect(peekSelectedAgentBackendId(path)).toBe("opencode")
  })

  test("union includes override backends", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = openWritable(path)
    try {
      ensureConfigTable(db)
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO config (id, selected_agent_backend) VALUES ('default', 'opencode')`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-1', NULL)`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-2', 'grok')`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-3', 'grok')`,
      )
    } finally {
      db.close()
    }

    expect(peekSelectedAgentBackendIds(path)).toEqual(["opencode", "grok"])
    expect(peekSelectedAgentBackendId(path)).toBe("opencode")
  })

  test("config default alone when it is not OpenCode and no overrides", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = openWritable(path)
    try {
      ensureConfigTable(db)
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO config (id, selected_agent_backend) VALUES ('default', 'grok')`,
      )
    } finally {
      db.close()
    }

    expect(peekSelectedAgentBackendIds(path)).toEqual(["grok"])
    expect(peekSelectedAgentBackendId(path)).toBe("grok")
  })

  test("singular peeks config only when override is OpenCode and default is Grok", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = openWritable(path)
    try {
      ensureConfigTable(db)
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO config (id, selected_agent_backend) VALUES ('default', 'grok')`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-1', 'opencode')`,
      )
    } finally {
      db.close()
    }

    // Plural union: product default first when present, then remaining sorted.
    expect(peekSelectedAgentBackendIds(path)).toEqual(["opencode", "grok"])
    // Singular remains config-only, not "first of ordered union".
    expect(peekSelectedAgentBackendId(path)).toBe("grok")
  })

  test("ignores unknown and blank repository overrides", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = openWritable(path)
    try {
      ensureConfigTable(db)
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO config (id, selected_agent_backend) VALUES ('default', 'opencode')`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-1', 'not-a-backend')`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-2', '  ')`,
      )
    } finally {
      db.close()
    }

    expect(peekSelectedAgentBackendIds(path)).toEqual(["opencode"])
  })

  test("missing repository table still returns config default", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = openWritable(path)
    try {
      ensureConfigTable(db)
      db.run(
        `INSERT INTO config (id, selected_agent_backend) VALUES ('default', 'grok')`,
      )
    } finally {
      db.close()
    }

    expect(peekSelectedAgentBackendIds(path)).toEqual(["grok"])
  })

  test("file: URI paths work", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = openWritable(path)
    try {
      ensureConfigTable(db)
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO config (id, selected_agent_backend) VALUES ('default', 'opencode')`,
      )
      db.run(
        `INSERT INTO repository (id, selected_agent_backend) VALUES ('repo-1', 'grok')`,
      )
    } finally {
      db.close()
    }

    expect(peekSelectedAgentBackendIds(`file:${path}`)).toEqual([
      "opencode",
      "grok",
    ])
  })
})
