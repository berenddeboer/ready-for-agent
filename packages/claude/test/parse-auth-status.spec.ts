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
    ).toEqual({ kind: "authenticated" })
  })

  it("recognizes loggedIn false JSON as unauthenticated", () => {
    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }), 1),
    ).toEqual({ kind: "unauthenticated" })
  })

  it("classifies authenticated JSON when stderr noise follows the object", () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn":true,"authMethod":"claude.ai"}\nwarning: ambient noise',
        0,
      ),
    ).toEqual({ kind: "authenticated" })
  })

  it("classifies unauthenticated JSON when stderr noise follows the object", () => {
    expect(
      parseClaudeAuthStatus(
        '{"loggedIn":false,"authMethod":null}\nwarning: ambient noise',
        1,
      ),
    ).toEqual({ kind: "unauthenticated" })
  })

  it("recognizes human-readable not logged in", () => {
    expect(parseClaudeAuthStatus("Not logged in\n", 1)).toEqual({
      kind: "unauthenticated",
    })
  })

  it("treats unauthenticated human copy as unauth, not authenticated", () => {
    expect(parseClaudeAuthStatus("You are unauthenticated.\n", 1)).toEqual({
      kind: "unauthenticated",
    })
    expect(parseClaudeAuthStatus("Not authenticated\n", 1)).toEqual({
      kind: "unauthenticated",
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
