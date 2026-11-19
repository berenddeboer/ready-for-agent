import {
  parseCiRepairRetryMarker,
  resolveObservedRetryTarget,
} from "../src/lib/ci-repair-retry.js"
import {
  buildCiRepairImplementPrompt,
  buildCiRepairNoChangeConfirmationPrompt,
  ciRepairIssueTitle,
  observationQualifiesForAutomaticCiRepair,
  parseCiRepairFailingRuns,
  serializeCiRepairFailingRuns,
} from "../src/lib/ci-repair-work-item.js"
import { describe, expect, it } from "bun:test"

describe("CI Repair Work Item helpers", () => {
  it("only authorizes one captured failing run and its original attempt", () => {
    const runs = [{ runIdentity: "10:2", htmlUrl: null, displayLabel: "CI" }]
    expect(resolveObservedRetryTarget("10", runs)).toEqual({
      runId: 10,
      attempt: 2,
    })
    expect(resolveObservedRetryTarget("10:3", runs)).toBeNull()
    expect(resolveObservedRetryTarget("20", runs)).toBeNull()
    expect(resolveObservedRetryTarget("10", [])).toBeNull()
    expect(
      parseCiRepairRetryMarker(
        "READY_FOR_AGENT_RESULT: RETRY_FAILED_JOBS: 10 20",
      ),
    ).toEqual({ kind: "invalid" })
  })

  it("names the default branch without an Issue identity", () => {
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
      canRequestRetry: true,
    })
    expect(prompt).toContain("commit abc123")
    expect(prompt).toContain("(10:1): https://ci.example/10")
    expect(prompt).toContain("read-only")
    expect(prompt).toContain("RETRY_FAILED_JOBS")
    expect(prompt).not.toContain(
      "the harness reruns jobs only when you report a No-Change Outcome",
    )
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

  it("does not offer dispatch during no-change confirmation or on unsupported connections", () => {
    expect(buildCiRepairNoChangeConfirmationPrompt()).not.toContain(
      "RERUN_JOBS",
    )
    expect(buildCiRepairNoChangeConfirmationPrompt()).not.toContain(
      "RETRY_FAILED_JOBS",
    )
    expect(
      buildCiRepairImplementPrompt({
        defaultBranch: "main",
        headSha: null,
        failingRuns: [
          { runIdentity: "10:1", displayLabel: "build", htmlUrl: null },
        ],
        mode: "start",
        canRequestRetry: false,
      }),
    ).not.toContain("RETRY_FAILED_JOBS")
  })
})
