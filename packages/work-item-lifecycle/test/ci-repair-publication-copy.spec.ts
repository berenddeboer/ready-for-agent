import {
  buildCommitFallbackPromptWithCopy,
  buildHarnessPublicationFallbackCopy,
  buildPublicationCopyFormatCorrectionPrompt,
  buildPublicationCopyPrompt,
  normalizePublicationCopy,
  publicationCopyFromCommitMessage,
} from "../src/lib/publication-copy.js"
import { describe, expect, it } from "bun:test"

const NO_CLOSING_REFERENCE =
  "Do not include an Issue closing reference (no Closes #, no Fixes #)"

const linearSource = {
  tracker: "linear" as const,
  nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  displayId: "ENG-123",
  url: "https://linear.app/acme/issue/ENG-123",
}

describe("CI Repair publication copy", () => {
  it("omits every closing reference from CI Repair copy", () => {
    expect(
      normalizePublicationCopy(
        {
          title: "fix: ci",
          body: [
            "The workflow was already corrected on main.",
            "",
            "Closes #0",
            "Fixes #123",
            "- Resolves #4.",
          ].join("\n"),
        },
        0,
        undefined,
        { ciRepair: true },
      ),
    ).toEqual({
      title: "fix: ci",
      body: "The workflow was already corrected on main.",
    })
  })

  it("does not re-append a Linear identity for a CI Repair Work Item", () => {
    expect(
      normalizePublicationCopy(
        {
          title: "fix: ci",
          body: "The workflow was already corrected on main.\n\nLinear: ENG-123\nhttps://linear.app/acme/issue/ENG-123",
        },
        0,
        linearSource,
        { ciRepair: true },
      ),
    ).toEqual({
      title: "fix: ci",
      body: "The workflow was already corrected on main.",
    })
  })

  it("still appends the Issue closing reference for an ordinary Issue", () => {
    expect(
      normalizePublicationCopy(
        {
          title: "feat: widgets",
          body: "Adds the widgets endpoint used by the dashboard.",
        },
        7,
      ),
    ).toEqual({
      title: "feat: widgets",
      body: "Adds the widgets endpoint used by the dashboard.\n\nCloses #7",
    })
  })

  it("seeds CI Repair copy from a commit without fabricating Closes #0", () => {
    expect(
      publicationCopyFromCommitMessage(
        "Repair CI on main\n\nThe pipeline was already green.\n\nCloses #0",
        0,
        undefined,
        { ciRepair: true },
      ),
    ).toEqual({
      title: "Repair CI on main",
      body: "The pipeline was already green.",
    })
    expect(
      publicationCopyFromCommitMessage(
        "Repair CI on main\n\nFixes #88",
        0,
        undefined,
        { ciRepair: true },
      ),
    ).toEqual({
      title: "Repair CI on main",
      body: "",
    })
  })

  it("uses the Repair CI fallback title and omits a closing reference", () => {
    const untitled = buildHarnessPublicationFallbackCopy({
      issueNumber: 0,
      issueTitle: null,
      workItemId: "wi-ci-repair",
      ciRepair: true,
    })
    expect(untitled.title).toBe("Repair CI")
    expect(untitled.body).toContain("wi-ci-repair")
    expect(untitled.body).not.toContain("Closes")
    expect(untitled.body).not.toContain("Fixes")

    const titled = buildHarnessPublicationFallbackCopy({
      issueNumber: 0,
      issueTitle: "Repair CI on main",
      workItemId: "wi-ci-repair",
      ciRepair: true,
    })
    expect(titled.title).toBe("Repair CI on main")
    expect(titled.body).not.toContain("#0")
  })

  it("tells the model not to include an Issue closing reference", () => {
    const prompt = buildPublicationCopyPrompt({
      issueNumber: 0,
      attachmentDirectory: "/tmp/attachments",
      ciRepair: true,
    })
    expect(prompt).toContain(NO_CLOSING_REFERENCE)
    expect(prompt).not.toContain("Closes #0")

    const issuePrompt = buildPublicationCopyPrompt({
      issueNumber: 42,
      attachmentDirectory: "/tmp/attachments",
    })
    expect(issuePrompt).not.toContain(NO_CLOSING_REFERENCE)
    expect(issuePrompt).toContain("#42")

    expect(
      buildPublicationCopyFormatCorrectionPrompt({
        issueNumber: 0,
        attachmentDirectory: "/tmp/attachments",
        ciRepair: true,
      }),
    ).toContain(NO_CLOSING_REFERENCE)
    expect(
      buildPublicationCopyFormatCorrectionPrompt({
        issueNumber: 42,
        attachmentDirectory: "/tmp/attachments",
      }),
    ).not.toContain(NO_CLOSING_REFERENCE)

    const fallback = buildCommitFallbackPromptWithCopy({
      issueNumber: 0,
      title: "fix: ci",
      body: "The workflow was already corrected on main.",
      diagnostics: "git commit failed",
      ciRepair: true,
    })
    expect(fallback).toContain(NO_CLOSING_REFERENCE)
    expect(fallback).not.toContain("must still close")

    const issueFallback = buildCommitFallbackPromptWithCopy({
      issueNumber: 42,
      title: "feat: widgets",
      body: "Adds widgets.",
      diagnostics: "git commit failed",
    })
    expect(issueFallback).toContain(
      "The commit must still close GitHub issue #42",
    )
    expect(issueFallback).not.toContain(NO_CLOSING_REFERENCE)
  })
})
