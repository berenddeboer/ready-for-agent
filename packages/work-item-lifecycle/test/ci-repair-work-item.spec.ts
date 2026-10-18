import {
  CI_REPAIR_ISSUE_NATIVE_ID,
  CI_REPAIR_ISSUE_NUMBER,
  buildCiRepairImplementPrompt,
  buildCiRepairNoChangeConfirmationPrompt,
  ciRepairIssueTitle,
  observationQualifiesForAutomaticCiRepair,
  parseCiRepairFailingRuns,
  parseCiRepairNoChangeResult,
  serializeCiRepairFailingRuns,
} from "../src/lib/ci-repair-work-item.js"
import { describe, expect, it } from "bun:test"

describe("CI Repair Work Item helpers", () => {
  it("uses a sentinel issue identity and a default-branch title", () => {
    expect(CI_REPAIR_ISSUE_NUMBER).toBe(0)
    expect(CI_REPAIR_ISSUE_NATIVE_ID).toBe("ci-repair")
    expect(ciRepairIssueTitle("main")).toBe("Repair CI on main")
  })

  it("round-trips failing-run links and drops malformed entries", () => {
    const raw = serializeCiRepairFailingRuns([
      {
        runIdentity: "99:1",
        htmlUrl: "https://ci.example/99",
        displayLabel: "build",
      },
      {
        runIdentity: "100:2",
        htmlUrl: null,
        displayLabel: "lint",
      },
    ])
    expect(parseCiRepairFailingRuns(raw)).toEqual([
      {
        runIdentity: "99:1",
        htmlUrl: "https://ci.example/99",
        displayLabel: "build",
      },
      {
        runIdentity: "100:2",
        htmlUrl: null,
        displayLabel: "lint",
      },
    ])
    expect(parseCiRepairFailingRuns("not-json")).toEqual([])
    expect(
      parseCiRepairFailingRuns(
        JSON.stringify([{ htmlUrl: "https://ci.example" }]),
      ),
    ).toEqual([])
  })

  it("auto-starts on a terminal failure and on an older latched failure", () => {
    expect(
      observationQualifiesForAutomaticCiRepair({
        failureLatched: true,
        latchedRunIdentity: "10:1",
        lastRunIdentity: "10:1",
        lastRawStatus: "completed",
        lastRawConclusion: "failure",
      }),
    ).toBe(true)
    expect(
      observationQualifiesForAutomaticCiRepair({
        failureLatched: true,
        latchedRunIdentity: "10:1",
        lastRunIdentity: "11:1",
        lastRawStatus: "in_progress",
        lastRawConclusion: null,
      }),
    ).toBe(true)
    expect(
      observationQualifiesForAutomaticCiRepair({
        failureLatched: true,
        latchedRunIdentity: "11:1",
        lastRunIdentity: "11:1",
        lastRawStatus: "in_progress",
        lastRawConclusion: null,
      }),
    ).toBe(false)
    expect(
      observationQualifiesForAutomaticCiRepair({
        failureLatched: false,
        latchedRunIdentity: null,
        lastRunIdentity: "10:1",
        lastRawStatus: "completed",
        lastRawConclusion: "failure",
      }),
    ).toBe(false)
  })

  it("names failing runs in the implement prompt and keeps CI read-only", () => {
    const prompt = buildCiRepairImplementPrompt({
      defaultBranch: "main",
      headSha: "abc123",
      failingRuns: [
        {
          runIdentity: "10:1",
          htmlUrl: "https://ci.example/10",
          displayLabel: "build",
        },
      ],
      mode: "start",
    })
    expect(prompt).toContain("commit abc123")
    expect(prompt).toContain("https://ci.example/10")
    expect(prompt).toContain("read-only")
    expect(prompt).toContain("Do not create or close an Issue")
    expect(
      buildCiRepairImplementPrompt({
        defaultBranch: "main",
        headSha: null,
        failingRuns: [],
        mode: "start",
      }),
    ).toContain("last green run")
  })

  it("parses CI-repair no-change outcomes and rejects a blank rerun", () => {
    expect(
      parseCiRepairNoChangeResult("READY_FOR_AGENT_RESULT: CHANGES"),
    ).toEqual({
      _tag: "changes",
    })
    expect(
      parseCiRepairNoChangeResult(
        "Already green.\nREADY_FOR_AGENT_RESULT: NO_CHANGES",
      ),
    ).toEqual({ _tag: "no_changes", completionSummary: "Already green." })
    expect(
      parseCiRepairNoChangeResult(
        "Rerun the red job.\nREADY_FOR_AGENT_RESULT: RERUN_JOBS: 10:1, 11:2",
      ),
    ).toEqual({
      _tag: "rerun_jobs",
      completionSummary: "Rerun the red job.",
      runIdentities: ["10:1", "11:2"],
    })
    expect(
      parseCiRepairNoChangeResult("READY_FOR_AGENT_RESULT: RERUN_JOBS:"),
    ).toBeNull()
    expect(buildCiRepairNoChangeConfirmationPrompt()).toContain("RERUN_JOBS")
  })
})
