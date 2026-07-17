import { describe, expect, it } from "vitest"
import {
  InvalidVersionError,
  NothingToReleaseError,
  computeNextVersion,
} from "../src/index.js"

describe("computeNextVersion", () => {
  it("returns 0.1.0 as the first public version when there is no prior tag", () => {
    const result = computeNextVersion({
      lastVersion: null,
      commitMessages: ["feat: initial product surface"],
    })

    expect(result).toEqual({
      version: "0.1.0",
      releaseType: "minor",
      reason: expect.stringContaining("First public version"),
    })
  })

  it("bumps minor for feat commits", () => {
    const result = computeNextVersion({
      lastVersion: "0.1.0",
      commitMessages: ["feat: add install docs"],
    })

    expect(result).toMatchObject({
      version: "0.2.0",
      releaseType: "minor",
    })
  })

  it("bumps patch for fix commits", () => {
    const result = computeNextVersion({
      lastVersion: "1.2.3",
      commitMessages: ["fix: correct path resolution"],
    })

    expect(result).toMatchObject({
      version: "1.2.4",
      releaseType: "patch",
    })
  })

  it("bumps major for breaking changes on 0.x", () => {
    const result = computeNextVersion({
      lastVersion: "0.5.2",
      commitMessages: [
        "feat!: rename public CLI flags\n\nBREAKING CHANGE: --foo is now --bar",
      ],
    })

    expect(result).toMatchObject({
      version: "1.0.0",
      releaseType: "major",
    })
  })

  it("bumps major for BREAKING CHANGE footer without bang", () => {
    const result = computeNextVersion({
      lastVersion: "2.0.0",
      commitMessages: [
        "fix: drop legacy env\n\nBREAKING CHANGE: LEGACY_PATH is no longer read",
      ],
    })

    expect(result).toMatchObject({
      version: "3.0.0",
      releaseType: "major",
    })
  })

  it("accepts a v-prefixed last version", () => {
    const result = computeNextVersion({
      lastVersion: "v1.0.0",
      commitMessages: ["fix: patch something"],
    })

    expect(result).toMatchObject({
      version: "1.0.1",
      releaseType: "patch",
    })
  })

  it("chooses the highest bump among mixed commits", () => {
    const result = computeNextVersion({
      lastVersion: "1.0.0",
      commitMessages: ["chore: tooling", "fix: small bug", "feat: new command"],
    })

    expect(result).toMatchObject({
      version: "1.1.0",
      releaseType: "minor",
    })
  })

  it("fails when there is nothing releasable", () => {
    expect(() =>
      computeNextVersion({
        lastVersion: "1.0.0",
        commitMessages: ["chore: update deps", "docs: fix typo"],
      }),
    ).toThrow(NothingToReleaseError)
  })

  it("fails with a clear message when empty", () => {
    expect(() =>
      computeNextVersion({
        lastVersion: "1.0.0",
        commitMessages: [],
      }),
    ).toThrow(/Nothing to release/)
  })

  it("fails when last version is not valid semver", () => {
    expect(() =>
      computeNextVersion({
        lastVersion: "not-a-version",
        commitMessages: ["feat: x"],
      }),
    ).toThrow(InvalidVersionError)
  })
})
