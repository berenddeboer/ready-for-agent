import { join } from "node:path"
import { resolveGrokHome } from "../src/lib/grok-home.js"
import { describe, expect, test } from "bun:test"

describe("resolveGrokHome", () => {
  test("honors GROK_HOME when set", () => {
    expect(
      resolveGrokHome({
        env: { GROK_HOME: "/custom/grok", HOME: "/home/user" },
      }),
    ).toBe("/custom/grok")
  })

  test("defaults to $HOME/.grok", () => {
    expect(
      resolveGrokHome({
        env: { HOME: "/home/user" },
      }),
    ).toBe(join("/home/user", ".grok"))
  })

  test("explicit grokHome override wins over env", () => {
    expect(
      resolveGrokHome({
        grokHome: "/override",
        env: { GROK_HOME: "/custom/grok", HOME: "/home/user" },
      }),
    ).toBe("/override")
  })
})
