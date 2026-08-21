import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  peekForgeApiEndpoints,
  peekRepositoryForges,
} from "./peek-repository-forges.ts"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"

setDefaultTimeout(15_000)

const createTempDb = (): { readonly path: string; readonly root: string } => {
  const root = mkdtempSync(join(tmpdir(), "rfa-peek-forge-"))
  return { path: join(root, "ready-for-agent.db"), root }
}

const ensureRepositoryTable = (db: Database): void => {
  db.run(`
    CREATE TABLE IF NOT EXISTS repository (
      id TEXT PRIMARY KEY,
      forge TEXT NOT NULL DEFAULT 'github',
      forge_host TEXT NOT NULL DEFAULT 'github.com'
    )
  `)
}

describe("peekRepositoryForges", () => {
  let roots: string[] = []

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
    roots = []
  })

  test("returns no Forge requirements for missing or empty databases", () => {
    expect(peekRepositoryForges("/no/such/path/ready-for-agent.db")).toEqual([])
    expect(peekRepositoryForges(":memory:")).toEqual([])

    const { path, root } = createTempDb()
    roots.push(root)
    const db = new Database(path, { create: true })
    try {
      ensureRepositoryTable(db)
    } finally {
      db.close()
    }
    expect(peekRepositoryForges(path)).toEqual([])
  })

  test("returns the stable distinct Repository Forge set", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = new Database(path, { create: true })
    try {
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO repository (id, forge) VALUES ('repo-gitlab-1', 'gitlab')`,
      )
      db.run(
        `INSERT INTO repository (id, forge) VALUES ('repo-github', 'github')`,
      )
      db.run(
        `INSERT INTO repository (id, forge) VALUES ('repo-gitlab-2', 'gitlab')`,
      )
    } finally {
      db.close()
    }
    expect(peekRepositoryForges(path)).toEqual(["github", "gitlab"])
  })

  test("includes Azure DevOps in the stable distinct Repository Forge set", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = new Database(path, { create: true })
    try {
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO repository (id, forge) VALUES ('repo-ado', 'azure-devops')`,
      )
      db.run(
        `INSERT INTO repository (id, forge) VALUES ('repo-github', 'github')`,
      )
    } finally {
      db.close()
    }
    expect(peekRepositoryForges(path)).toEqual(["github", "azure-devops"])
  })

  test("treats non-empty pre-identity repository tables as GitHub", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = new Database(path, { create: true })
    try {
      db.run(`CREATE TABLE repository (id TEXT PRIMARY KEY)`)
      db.run(`INSERT INTO repository (id) VALUES ('repo-legacy')`)
    } finally {
      db.close()
    }
    expect(peekRepositoryForges(path)).toEqual(["github"])
  })
})

describe("peekForgeApiEndpoints", () => {
  let roots: string[] = []

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
    roots = []
  })

  test("returns no endpoints when there are no Repositories", () => {
    expect(peekForgeApiEndpoints(":memory:")).toEqual([])
  })

  test("maps GitHub Repositories to api.github.com once", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = new Database(path, { create: true })
    try {
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('r1', 'github', 'github.com')`,
      )
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('r2', 'github', 'github.com')`,
      )
    } finally {
      db.close()
    }
    expect(peekForgeApiEndpoints(path)).toEqual([
      { forge: "github", host: "api.github.com", path: "/" },
    ])
  })

  test("includes each distinct GitLab forge host", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = new Database(path, { create: true })
    try {
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('g1', 'gitlab', 'gitlab.com')`,
      )
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('g2', 'gitlab', 'git.drupalcode.org')`,
      )
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('gh', 'github', 'github.com')`,
      )
    } finally {
      db.close()
    }
    expect(peekForgeApiEndpoints(path)).toEqual([
      { forge: "github", host: "api.github.com", path: "/" },
      {
        forge: "gitlab",
        host: "git.drupalcode.org",
        path: "/api/v4/version",
      },
      { forge: "gitlab", host: "gitlab.com", path: "/api/v4/version" },
    ])
  })

  test("includes a single canonical Azure DevOps endpoint", () => {
    const { path, root } = createTempDb()
    roots.push(root)
    const db = new Database(path, { create: true })
    try {
      ensureRepositoryTable(db)
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('a1', 'azure-devops', 'dev.azure.com')`,
      )
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('a2', 'azure-devops', 'dev.azure.com')`,
      )
      db.run(
        `INSERT INTO repository (id, forge, forge_host) VALUES ('gh', 'github', 'github.com')`,
      )
    } finally {
      db.close()
    }
    expect(peekForgeApiEndpoints(path)).toEqual([
      { forge: "github", host: "api.github.com", path: "/" },
      {
        forge: "azure-devops",
        host: "dev.azure.com",
        path: "/_apis/connectionData",
      },
    ])
  })
})
