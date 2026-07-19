import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

describe("blank-slate add repository command", () => {
  test("loads suggested CLI from GraphQL and renders it in the empty state", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/routes/index.tsx"),
      "utf8",
    )
    expect(source).toContain("addRepositoryCommand")
    expect(source).toContain("addRepositoryCommandQuery")
    expect(source).toContain("{addRepositoryCommand}")
    expect(source).not.toContain(
      "ready-for-agent add /path/to/local/repo\n          </code>",
    )
  })
})
