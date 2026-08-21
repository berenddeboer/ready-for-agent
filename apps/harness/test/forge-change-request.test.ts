import {
  forgeChangeRequestNoun,
  forgeChangeRequestShort,
  normalizeForge,
} from "../src/forge-change-request.js"
import { describe, expect, test } from "bun:test"

describe("forge change-request labels", () => {
  test("normalizes unknown forges to github", () => {
    expect(normalizeForge(undefined)).toBe("github")
    expect(normalizeForge(null)).toBe("github")
    expect(normalizeForge("github")).toBe("github")
    expect(normalizeForge("gitlab")).toBe("gitlab")
    expect(normalizeForge("azure-devops")).toBe("azure-devops")
  })

  test("short token is PR on GitHub and MR on GitLab", () => {
    expect(forgeChangeRequestShort("github")).toBe("PR")
    expect(forgeChangeRequestShort(undefined)).toBe("PR")
    expect(forgeChangeRequestShort("gitlab")).toBe("MR")
    // Azure DevOps uses GitHub's pull-request terminology.
    expect(forgeChangeRequestShort("azure-devops")).toBe("PR")
  })

  test("noun is pull request / merge request", () => {
    expect(forgeChangeRequestNoun("github")).toBe("pull request")
    expect(forgeChangeRequestNoun("gitlab")).toBe("merge request")
    expect(forgeChangeRequestNoun("azure-devops")).toBe("pull request")
  })
})
