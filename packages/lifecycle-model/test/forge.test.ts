import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { FORGES, isForge } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("generated Forge vocabulary", () => {
  it("exports exactly the existing three runtime spellings in declared order", () => {
    expect([...FORGES]).toEqual(["github", "gitlab", "azure-devops"])
  })

  it("accepts the supported kinds and rejects unknown spellings", () => {
    expect(isForge("github")).toBe(true)
    expect(isForge("gitlab")).toBe(true)
    expect(isForge("azure-devops")).toBe(true)
    expect(isForge("bitbucket")).toBe(false)
    expect(isForge("GitHub")).toBe(false)
    expect(isForge("")).toBe(false)
    expect(isForge(undefined)).toBe(false)
  })

  it("keeps generated runtime free of RDF tooling", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../src/generated/forge.ts"),
      "utf8",
    )
    expect(source.includes('from "n3"')).toBe(false)
    expect(source.includes("rdf-validate-shacl")).toBe(false)
  })
})
