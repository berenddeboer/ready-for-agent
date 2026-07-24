import { sanitizeInheritedEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("sanitizeInheritedEnvironment", () => {
  it("drops only GitHub token names", () => {
    const result = sanitizeInheritedEnvironment({
      HOME: "/home/user",
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      GITHUB_TOKEN_REPO: "c",
      NOT_GITHUB_TOKEN: "keep",
    })
    expect(result).toEqual({
      HOME: "/home/user",
      NOT_GITHUB_TOKEN: "keep",
    })
  })
})
