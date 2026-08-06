import { claudeProviderIdentity } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("claudeProviderIdentity", () => {
  it("maps apiProvider bedrock to Amazon Bedrock", () => {
    expect(claudeProviderIdentity("bedrock")).toEqual({
      id: "bedrock",
      label: "Amazon Bedrock",
    })
  })

  it("maps firstParty distinctly from Bedrock", () => {
    expect(claudeProviderIdentity("firstParty")).toEqual({
      id: "firstParty",
      label: "First-party",
    })
    expect(claudeProviderIdentity("firstParty")?.label).not.toContain("Bedrock")
  })

  it("returns null for unknown providers (no env-flag inference)", () => {
    expect(claudeProviderIdentity("unknown")).toBeNull()
  })
})
