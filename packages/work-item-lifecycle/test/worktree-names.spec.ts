import {
  repositorySlug,
  workItemBranchName,
  workItemWorktreePath,
  worktreeParentPath,
} from "../src/lib/worktree-names.js"
import { describe, expect, it } from "bun:test"

describe("worktree names", () => {
  it("builds a repository slug from owner and name", () => {
    expect(repositorySlug("Acme", "Widgets")).toBe("acme-widgets")
    expect(repositorySlug("acme.org", "my_repo")).toBe("acme-org-my-repo")
  })

  it("builds a branch identifiable by repo, issue, and Work Item", () => {
    expect(
      workItemBranchName({
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId: "wi-01HABCDEFGHJKMNPQRSTVWXYZ",
      }),
    ).toBe("rfa/acme-widgets/42/wi-01HABCDEFGHJKMNPQRSTVWXYZ")
  })

  it("places dot-bare worktrees beside .bare in the project root", () => {
    expect(
      worktreeParentPath({
        localPath: "/home/berend/src/pf/monorepo/.bare",
        isBare: true,
        githubOwner: "pf",
        githubRepo: "monorepo",
      }),
    ).toBe("/home/berend/src/pf/monorepo")

    expect(
      workItemWorktreePath({
        localPath: "/home/berend/src/pf/monorepo/.bare",
        isBare: true,
        githubOwner: "pf",
        githubRepo: "monorepo",
        githubIssueNumber: 2039,
        workItemId: "wi-01HABCDEFGHJKMNPQRSTVWXYZ",
      }),
    ).toBe("/home/berend/src/pf/monorepo/2039-wi-01HABCDEFGHJKMNPQRSTVWXYZ")
  })

  it("places other bare worktrees under a sibling stem-worktrees directory", () => {
    expect(
      worktreeParentPath({
        localPath: "/repos/acme/widgets.git",
        isBare: true,
        githubOwner: "acme",
        githubRepo: "widgets",
      }),
    ).toBe("/repos/acme/widgets-worktrees")

    expect(
      workItemWorktreePath({
        localPath: "/repos/acme/widgets.git",
        isBare: true,
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId: "wi-01HABCDEFGHJKMNPQRSTVWXYZ",
      }),
    ).toBe("/repos/acme/widgets-worktrees/42-wi-01HABCDEFGHJKMNPQRSTVWXYZ")
  })

  it("places non-bare worktrees under the temporary ready-for-agent tree", () => {
    expect(
      worktreeParentPath({
        localPath: "/home/berend/src/acme/widgets",
        isBare: false,
        githubOwner: "acme",
        githubRepo: "widgets",
        tmpDir: "/tmp",
      }),
    ).toBe("/tmp/ready-for-agent/acme/widgets")

    expect(
      workItemWorktreePath({
        localPath: "/home/berend/src/acme/widgets",
        isBare: false,
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 7,
        workItemId: "wi-01HZZZZZZZZZZZZZZZZZZZZZZZ",
        tmpDir: "/var/tmp",
      }),
    ).toBe(
      "/var/tmp/ready-for-agent/acme/widgets/7-wi-01HZZZZZZZZZZZZZZZZZZZZZZZ",
    )
  })
})
