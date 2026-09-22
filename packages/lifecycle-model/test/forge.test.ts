import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  DEFAULT_ISSUE_TRACKER_BY_FORGE,
  FORGES,
  ISSUE_TRACKERS,
  type IssueSource,
  defaultIssueTrackerForForge,
  existingProviderIssueIdentity,
  forgeForIssueSource,
  forgeIssueSource,
  formatIssueDisplayId,
  isForge,
  isIssueTracker,
  persistedIssueIdentity,
  relevancePolicyForIssueTracker,
} from "../src/index.js"
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

  it("exports Issue Tracker kinds including the tracker-only kinds without making them Forges", () => {
    expect([...ISSUE_TRACKERS]).toEqual([
      "github",
      "gitlab",
      "azure-devops",
      "linear",
      "fp",
    ])
    for (const trackerOnly of ["linear", "fp"] as const) {
      expect(isIssueTracker(trackerOnly)).toBe(true)
      expect(isForge(trackerOnly)).toBe(false)
      expect(relevancePolicyForIssueTracker(trackerOnly)).toEqual({
        hierarchyObservation: { kind: "required" },
        openDraftClosingPullRequest: { kind: "inactive" },
      })
    }
    expect(isIssueTracker("github")).toBe(true)
    expect(isIssueTracker("bitbucket")).toBe(false)
  })

  it("defaults each Forge's Issue Tracker to itself", () => {
    expect(DEFAULT_ISSUE_TRACKER_BY_FORGE).toEqual({
      github: "github",
      gitlab: "gitlab",
      "azure-devops": "azure-devops",
    })
    expect(defaultIssueTrackerForForge("github")).toBe("github")
    expect(defaultIssueTrackerForForge("gitlab")).toBe("gitlab")
    expect(defaultIssueTrackerForForge("azure-devops")).toBe("azure-devops")
  })

  it("represents tracker-native identity separately from display identifiers and URLs", () => {
    expect(
      forgeIssueSource({
        tracker: "github",
        issueNumber: 42,
        url: "https://github.com/acme/widgets/issues/42",
      }),
    ).toEqual({
      tracker: "github",
      nativeId: "42",
      displayId: "42",
      url: "https://github.com/acme/widgets/issues/42",
    })
    const linearSource: IssueSource = {
      tracker: "linear",
      nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      displayId: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123",
    }
    expect(linearSource.nativeId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    expect(linearSource.displayId).toBe("ENG-123")
    expect(linearSource.nativeId).not.toBe(linearSource.displayId)
    expect(Number.parseInt(linearSource.nativeId, 10)).toBeNaN()
    expect(
      existingProviderIssueIdentity({ tracker: "gitlab", issueNumber: 7 }),
    ).toEqual({
      issueTracker: "gitlab",
      nativeId: "7",
      displayId: "7",
    })
    expect(persistedIssueIdentity({ issueNumber: 42 })).toEqual({
      nativeId: "42",
      displayId: "42",
    })
    expect(
      persistedIssueIdentity({
        issueNumber: 42,
        nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        displayId: "ENG-123",
      }),
    ).toEqual({
      nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      displayId: "ENG-123",
    })
    expect(formatIssueDisplayId("42")).toBe("#42")
    expect(formatIssueDisplayId("ENG-123")).toBe("ENG-123")
  })

  it("maps Forge-hosted Original Issue Source to a Forge and Linear to none", () => {
    expect(
      forgeForIssueSource(
        forgeIssueSource({
          tracker: "github",
          issueNumber: 42,
          url: "https://github.com/acme/widgets/issues/42",
        }),
      ),
    ).toBe("github")
    expect(
      forgeForIssueSource(
        forgeIssueSource({
          tracker: "gitlab",
          issueNumber: 9,
          url: "https://git.drupalcode.org/project/oauth_client/-/issues/9",
        }),
      ),
    ).toBe("gitlab")
    expect(
      forgeForIssueSource({
        tracker: "linear",
        nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        displayId: "ENG-123",
        url: "https://linear.app/acme/issue/ENG-123",
      }),
    ).toBeNull()
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
