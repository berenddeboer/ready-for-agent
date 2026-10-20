import {
  classifyFpFailure,
  fpIssueLabels,
  parseFpAuthStatus,
  parseFpIssueList,
  parseFpIssueShow,
  parseFpProjectRemote,
  parseFpVersion,
} from "../src/lib/fp-cli-output.js"
import { describe, expect, test } from "bun:test"

// Transcripts captured from fp 0.25.0 (d818046) on 2026-09-22.

const LIST_OUTPUT = JSON.stringify({
  issues: [
    {
      id: "sxflialvmviogismmsczmwrvnsdbpnrb",
      shortId: "sxflialv",
      title: "fp tracker 4: execution",
      description: "Plan section 4, item 4.",
      status: "todo",
      priority: "high",
      parent: "qnijsazsvqabyjjrappukabhccvtodey",
      dependencies: [
        "peomwupiocfoiirgpjolwhfohsczfsde",
        "xfuurawudexxmdrstcwirfnxyohgyzsz",
      ],
      createdAt: "2026-09-20T16:11:26.316Z",
      updatedAt: "2026-09-22T05:55:48.990Z",
    },
    {
      id: "qnijsazsvqabyjjrappukabhccvtodey",
      shortId: "qnijsazs",
      title: "Epic",
      description: "",
      status: "todo",
      priority: "high",
      parent: null,
      dependencies: [],
      createdAt: "2026-09-08T07:07:50.896Z",
      updatedAt: "2026-09-22T07:00:00.000Z",
    },
  ],
})

const SHOW_OUTPUT = JSON.stringify({
  id: "sxflialvmviogismmsczmwrvnsdbpnrb",
  displayId: "RFA-sxflialv",
  title: "fp tracker 4: execution",
  description: "Plan section 4, item 4.",
  status: "todo",
  priority: "high",
  parent: "qnijsazsvqabyjjrappukabhccvtodey",
  dependencies: [
    "peomwupiocfoiirgpjolwhfohsczfsde",
    "xfuurawudexxmdrstcwirfnxyohgyzsz",
  ],
  revisions: [],
  author: "github@hissinkmuller.nl",
  createdAt: "2026-09-20T16:11:26.316Z",
  updatedAt: "2026-09-22T05:55:48.990Z",
  properties: { labels: ["fp-tracker"] },
  comments: [
    {
      id: "c1",
      author: "a",
      content: "x",
      createdAt: "2026-09-22T00:00:00.000Z",
    },
  ],
})

const AUTH_STATUS_OUTPUT = `✓ Token valid

  Source: /Users/mark/.fiberplane/credentials.toml
  Token: YMQvNYBH...

  Name: Mark HM
  Email: github@hissinkmuller.nl

`

describe("fp issue list parsing", () => {
  test("reads the wrapped issues array with parent and dependencies", () => {
    const issues = parseFpIssueList(LIST_OUTPUT)
    expect(issues.map((issue) => issue.shortId)).toEqual([
      "sxflialv",
      "qnijsazs",
    ])
    expect(issues[0]?.parent).toBe("qnijsazsvqabyjjrappukabhccvtodey")
    expect(issues[0]?.dependencies).toHaveLength(2)
    expect(issues[1]?.parent).toBeNull()
  })

  test("list output carries no properties, so labels cannot be read from it", () => {
    const issues = parseFpIssueList(LIST_OUTPUT)
    expect("properties" in (issues[0] as object)).toBe(false)
  })

  test("rejects output that is not the list shape", () => {
    expect(() => parseFpIssueList("[]")).toThrow()
    expect(() => parseFpIssueList("not json")).toThrow()
  })
})

describe("fp issue show parsing", () => {
  test("reads display id, author and labels", () => {
    const issue = parseFpIssueShow(SHOW_OUTPUT)
    expect(issue.displayId).toBe("RFA-sxflialv")
    expect(issue.author).toBe("github@hissinkmuller.nl")
    expect(fpIssueLabels(issue)).toEqual(["fp-tracker"])
  })

  test("treats absent or null labels as none", () => {
    const withoutProperties = parseFpIssueShow(
      JSON.stringify({
        id: "a".repeat(32),
        displayId: "RFA-aaaaaaaa",
        title: "t",
        status: "todo",
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      }),
    )
    expect(fpIssueLabels(withoutProperties)).toEqual([])
    const nullLabels = parseFpIssueShow(
      JSON.stringify({
        id: "a".repeat(32),
        displayId: "RFA-aaaaaaaa",
        title: "t",
        status: "todo",
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
        properties: { labels: null },
      }),
    )
    expect(fpIssueLabels(nullLabels)).toEqual([])
  })
})

describe("fp auth status parsing", () => {
  test("extracts the operator email and name", () => {
    expect(parseFpAuthStatus(AUTH_STATUS_OUTPUT)).toEqual({
      name: "Mark HM",
      email: "github@hissinkmuller.nl",
    })
  })

  test("returns null without an Email line", () => {
    expect(parseFpAuthStatus("Not logged in\n")).toBeNull()
  })
})

// Captured from `fp project remote --format json` on fp 0.25.0, 2026-09-22.
const PROJECT_REMOTE_OUTPUT = JSON.stringify({
  projectId: "maj1jnV31wzqoUjtAXNMd",
  workspaceSlug: "markhm-jcVg",
  serverUrl: "https://app.fp.dev",
  linkedAt: "2026-09-21T06:17:07.152Z",
  lastSyncedAt: "2026-09-22T11:12:06.121Z",
})

describe("fp project remote parsing", () => {
  test("reads the workspace slug and remote project id of a linked project", () => {
    expect(parseFpProjectRemote(PROJECT_REMOTE_OUTPUT)).toEqual({
      workspaceSlug: "markhm-jcVg",
      projectId: "maj1jnV31wzqoUjtAXNMd",
    })
  })

  test("rejects the unlinked project's prose, which fp prints with exit 1", () => {
    expect(() =>
      parseFpProjectRemote(
        "Project not linked to remote\n  Suggestion: No local project is registered here and no remote identity was found.\n",
      ),
    ).toThrow()
  })
})

describe("fp version parsing", () => {
  test("reads the semantic version before the commit hash", () => {
    expect(parseFpVersion("0.25.0 (d818046)\n")).toBe("0.25.0")
    expect(parseFpVersion("garbage")).toBeNull()
  })
})

describe("fp failure classification", () => {
  test("recognises the three messages fp prints on 0.25.0", () => {
    expect(
      classifyFpFailure(
        ".fp directory not found\n  Suggestion: Run 'fp init' to initialize a project\n",
      ),
    ).toBe("project_not_registered")
    expect(
      classifyFpFailure(
        "This path is not registered with fp, but there are issues stored for 1 other location:\n",
      ),
    ).toBe("project_not_registered")
    expect(
      classifyFpFailure(
        "Issue nope not found\n  Suggestion: Run 'fp issue list' to see available issues\n",
      ),
    ).toBe("issue_not_found")
    expect(
      classifyFpFailure(
        'Invalid status: Status "todo,selected" is not in the registered options.\n',
      ),
    ).toBe("invalid_status")
    expect(classifyFpFailure("segfault")).toBe("unknown")
  })
})
