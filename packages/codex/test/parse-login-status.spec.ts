import { parseCodexLoginStatus } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("parseCodexLoginStatus", () => {
  it("recognizes ChatGPT OAuth success (real CLI wording)", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT\n", 0)).toEqual({
      kind: "authenticated",
    })
  })

  it("recognizes API key login success (real CLI wording)", () => {
    expect(
      parseCodexLoginStatus("Logged in using an API key - sk-…\n", 0),
    ).toEqual({
      kind: "authenticated",
    })
  })

  it("recognizes Not logged in", () => {
    expect(parseCodexLoginStatus("Not logged in\n", 1)).toEqual({
      kind: "unauthenticated",
    })
  })

  it("treats non-zero exit without markers as failed, not unauthenticated", () => {
    expect(parseCodexLoginStatus("", 1)).toEqual({
      kind: "failed",
      exitCode: 1,
    })
    expect(parseCodexLoginStatus("segfault dump\n", 139)).toEqual({
      kind: "failed",
      exitCode: 139,
    })
  })

  it("treats exit-zero garbage as malformed", () => {
    expect(parseCodexLoginStatus("unexpected banner only\n", 0)).toEqual({
      kind: "malformed",
    })
  })
})
