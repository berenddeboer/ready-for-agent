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

  it("treats finished Work Items as non-blocking for candidates", () => {
    const candidates = classifyIntakeCandidates(
      [issue({ issueNumber: 8 })],
      [workItem({ issueNumber: 8, state: "complete" })],
    )
    expect(candidates).toEqual([
      {
        issueNumber: 8,
        title: "Issue 8",
        url: "https://github.com/acme/widgets/issues/8",
        action: "IMPLEMENT_NOW",
      },
    ])
  })

  it("returns empty for an empty Issue projection", () => {
    expect(classifyIntakeCandidates([], [])).toEqual([])
  })
})
