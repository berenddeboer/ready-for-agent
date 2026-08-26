import {
  type IntakeCandidateIssueInput,
  type IntakeCandidateWorkItemInput,
  classifyIntakeCandidates,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const issue = (
  overrides: Partial<IntakeCandidateIssueInput> & {
    readonly issueNumber: number
  },
): IntakeCandidateIssueInput => ({
  title: `Issue ${overrides.issueNumber}`,
  url: `https://github.com/acme/widgets/issues/${overrides.issueNumber}`,
  state: "OPEN",
  hasChildren: false,
  blockedBy: [],
  ...overrides,
})

const workItem = (
  overrides: Partial<IntakeCandidateWorkItemInput> & {
    readonly issueNumber: number
    readonly state: IntakeCandidateWorkItemInput["state"]
  },
): IntakeCandidateWorkItemInput => ({
  id: `wi-${overrides.issueNumber}`,
  canRetry: false,
  ...overrides,
})

describe("classifyIntakeCandidates", () => {
  it("classifies Actionable Issues as IMPLEMENT_NOW", () => {
    const candidates = classifyIntakeCandidates(
      [issue({ issueNumber: 10 })],
      [],
    )
    expect(candidates).toEqual([
      {
        issueNumber: 10,
        title: "Issue 10",
        url: "https://github.com/acme/widgets/issues/10",
        action: "IMPLEMENT_NOW",
      },
    ])
  })

  it("classifies blocked open leaves as QUEUE", () => {
    const candidates = classifyIntakeCandidates(
      [
        issue({
          issueNumber: 20,
          blockedBy: [{ issueNumber: 1, issueUrl: "https://example/1" }],
        }),
      ],
      [],
    )
    expect(candidates).toEqual([
      {
        issueNumber: 20,
        title: "Issue 20",
        url: "https://github.com/acme/widgets/issues/20",
        action: "QUEUE",
      },
    ])
  })

  it("omits parents, closed Issues, and unfinished Work Items", () => {
    const candidates = classifyIntakeCandidates(
      [
        issue({ issueNumber: 1, hasChildren: true }),
        issue({ issueNumber: 2, state: "CLOSED" }),
        issue({ issueNumber: 3 }),
        issue({
          issueNumber: 4,
          blockedBy: [{ issueNumber: 9, issueUrl: "https://example/9" }],
        }),
      ],
      [
        workItem({ issueNumber: 3, state: "implement" }),
        workItem({ issueNumber: 4, state: "create_worktree" }),
      ],
    )
    expect(candidates).toEqual([])
  })

  it("orders IMPLEMENT_NOW then QUEUE, each by ascending Issue number", () => {
    const candidates = classifyIntakeCandidates(
      [
        issue({
          issueNumber: 30,
          blockedBy: [{ issueNumber: 1, issueUrl: "https://example/1" }],
        }),
        issue({ issueNumber: 12 }),
        issue({
          issueNumber: 5,
          blockedBy: [{ issueNumber: 1, issueUrl: "https://example/1" }],
        }),
        issue({ issueNumber: 7 }),
      ],
      [],
    )
    expect(candidates.map((c) => [c.issueNumber, c.action])).toEqual([
      [7, "IMPLEMENT_NOW"],
      [12, "IMPLEMENT_NOW"],
      [5, "QUEUE"],
      [30, "QUEUE"],
    ])
  })

  it("treats failed and abandoned Work Items as non-blocking for candidates", () => {
    const candidates = classifyIntakeCandidates(
      [issue({ issueNumber: 8 }), issue({ issueNumber: 9 })],
      [
        workItem({ issueNumber: 8, state: "failed" }),
        workItem({ issueNumber: 9, state: "abandoned" }),
      ],
    )
    expect(candidates.map((c) => c.issueNumber)).toEqual([8, 9])
  })

  describe("terminal Complete Work Item recandidate guard (#1210)", () => {
    it("omits a still-open ready-labeled Issue that already has a Complete Work Item", () => {
      // Defense in depth for a missed forge close-out: the Issue can stay
      // OPEN and ready-labeled after the Work Item already shipped.
      const candidates = classifyIntakeCandidates(
        [issue({ issueNumber: 8, state: "OPEN" })],
        [workItem({ issueNumber: 8, state: "complete" })],
      )
      expect(candidates).toEqual([])
    })

    it("omits a blocked Issue with a Complete Work Item as QUEUE", () => {
      const candidates = classifyIntakeCandidates(
        [
          issue({
            issueNumber: 8,
            blockedBy: [{ issueNumber: 1, issueUrl: "https://example/1" }],
          }),
        ],
        [workItem({ issueNumber: 8, state: "complete" })],
      )
      expect(candidates).toEqual([])
    })

    it("still offers an Issue with no Work Item as IMPLEMENT_NOW", () => {
      const candidates = classifyIntakeCandidates(
        [issue({ issueNumber: 11, state: "OPEN" })],
        [],
      )
      expect(candidates.map((c) => [c.issueNumber, c.action])).toEqual([
        [11, "IMPLEMENT_NOW"],
      ])
    })

    it("still offers Failed-with-Issue-still-Ready as IMPLEMENT_NOW", () => {
      const candidates = classifyIntakeCandidates(
        [issue({ issueNumber: 12, state: "OPEN" })],
        [workItem({ issueNumber: 12, state: "failed" })],
      )
      expect(candidates.map((c) => [c.issueNumber, c.action])).toEqual([
        [12, "IMPLEMENT_NOW"],
      ])
    })

    it("does not treat Needs Human as Complete — unfinished still blocks candidacy", () => {
      const candidates = classifyIntakeCandidates(
        [issue({ issueNumber: 13, state: "OPEN" })],
        [workItem({ issueNumber: 13, state: "needs_human" })],
      )
      expect(candidates).toEqual([])
    })

    it("offers the still-Ready Issue again after the Complete Work Item is erased", () => {
      const stillReady = issue({ issueNumber: 14, state: "OPEN" })
      expect(
        classifyIntakeCandidates(
          [stillReady],
          [workItem({ issueNumber: 14, state: "complete" })],
        ),
      ).toEqual([])
      expect(classifyIntakeCandidates([stillReady], [])).toEqual([
        {
          issueNumber: 14,
          title: "Issue 14",
          url: "https://github.com/acme/widgets/issues/14",
          action: "IMPLEMENT_NOW",
        },
      ])
    })

    it("applies the same Complete veto for GitHub and GitLab Issue URLs", () => {
      const githubIssue = issue({
        issueNumber: 21,
        url: "https://github.com/acme/widgets/issues/21",
      })
      const gitlabIssue = issue({
        issueNumber: 22,
        url: "https://gitlab.example.com/acme/widgets/-/issues/22",
      })
      expect(
        classifyIntakeCandidates(
          [githubIssue, gitlabIssue],
          [
            workItem({ issueNumber: 21, state: "complete" }),
            workItem({ issueNumber: 22, state: "complete" }),
          ],
        ),
      ).toEqual([])
    })
  })

  it("returns empty for an empty Issue projection", () => {
    expect(classifyIntakeCandidates([], [])).toEqual([])
  })
})
