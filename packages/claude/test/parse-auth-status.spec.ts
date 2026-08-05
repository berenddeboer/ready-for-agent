import { extractFirstJsonObject, parseClaudeAuthStatus } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("extractFirstJsonObject", () => {
  it("returns the first balanced object and ignores trailing noise", () => {
    expect(
      extractFirstJsonObject(
        '{"loggedIn":true,"authMethod":"claude.ai"}\nwarning: noise',
      ),
    ).toBe('{"loggedIn":true,"authMethod":"claude.ai"}')
  })

  it("handles braces inside JSON strings", () => {
    expect(
      extractFirstJsonObject('{"loggedIn":true,"note":"has { and } chars"}'),
    ).toBe('{"loggedIn":true,"note":"has { and } chars"}')
  })
})

describe("parseClaudeAuthStatus", () => {
  it("recognizes loggedIn true JSON (real CLI shape)", () => {
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "op@example.com",
        }),
        0,
      ),
    ).toEqual({ kind: "authenticated", provider: "firstParty" })
  })

  it("recognizes Bedrock third-party auth status as authenticated (real CLI shape)", () => {
    // Verified under CLAUDE_CODE_USE_BEDROCK: loggedIn true, third_party, bedrock.
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "third_party",
          apiProvider: "bedrock",
        }),
        0,
      ),
    ).toEqual({ kind: "authenticated", provider: "bedrock" })
  })

  it("classifies Bedrock from apiProvider, not from missing claude.ai login", () => {
    // First-party not logged in must never be inferred as Bedrock readiness.
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: false,
          authMethod: null,
          apiProvider: "firstParty",
        }),
        1,
      ),
    ).toEqual({ kind: "unauthenticated", provider: "firstParty" })

    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }), 1),
    ).toEqual({ kind: "unauthenticated", provider: "unknown" })

    // apiProvider alone without a loggedIn boolean is not ready.
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({ apiProvider: "bedrock", authMethod: "third_party" }),
        0,
      ),
    ).toEqual({ kind: "malformed" })
  })

  it("classifies Bedrock loggedIn false as unauthenticated with bedrock provider", () => {
    // Issue #802 inspect maps this shape to Bedrock/AWS Unavailable copy.
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({
          loggedIn: false,
          authMethod: "third_party",
          apiProvider: "bedrock",
        }),
        1,
      ),
    ).toEqual({ kind: "unauthenticated", provider: "bedrock" })
  })

  it("recognizes loggedIn false JSON as unauthenticated", () => {
    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }), 1),
    ).toEqual({ kind: "unauthenticated", provider: "unknown" })
  })

  it("classifies authenticated JSON when stderr noise follows the object", () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn":true,"authMethod":"claude.ai"}\nwarning: ambient noise',
        0,
      ),
    ).toEqual({ kind: "authenticated", provider: "unknown" })
  })

  it("classifies unauthenticated JSON when stderr noise follows the object", () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn":false,"authMethod":null}\nwarning: ambient noise',
        1,
      ),
    ).toEqual({ kind: "unauthenticated", provider: "unknown" })
  })

  it("recognizes human-readable not logged in", () => {
    expect(parseClaudeAuthStatus("Not logged in\n", 1)).toEqual({
      kind: "unauthenticated",
      provider: "unknown",
    })
  })

  it("treats unauthenticated human copy as unauth, not authenticated", () => {
    expect(parseClaudeAuthStatus("You are unauthenticated.\n", 1)).toEqual({
      kind: "unauthenticated",
      provider: "unknown",
    })
    expect(parseClaudeAuthStatus("Not authenticated\n", 1)).toEqual({
      kind: "unauthenticated",
      provider: "unknown",
    })
  })

  it("does not treat authMethod field dumps as authenticated", () => {
    // No parseable loggedIn boolean; field name alone must not flip ready.
    expect(
      parseClaudeAuthStatus('prefix {"authMethod":"claude.ai"} trailing', 0),
    ).toEqual({ kind: "malformed" })
  })

  it("recognizes human-readable logged in after unauth markers are ruled out", () => {
    expect(parseClaudeAuthStatus("Logged in as op@example.com\n", 0)).toEqual({
      kind: "authenticated",
      provider: "unknown",
    })
  })

  it("treats non-zero exit without auth markers as failed, not unauthenticated", () => {
    expect(parseClaudeAuthStatus("", 1)).toEqual({
      kind: "failed",
      exitCode: 1,
    })
    expect(parseClaudeAuthStatus("segfault dump\n", 139)).toEqual({
      kind: "failed",
      exitCode: 139,
    })
  })

  it("treats exit-zero garbage as malformed", () => {
    expect(parseClaudeAuthStatus("unexpected banner only\n", 0)).toEqual({
      kind: "malformed",
    })
  })
})
