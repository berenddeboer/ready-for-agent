import {
  archiveLegLaneStyle,
  archiveLegText,
  formatArchiveLegDuration,
  planArchiveLegs,
} from "../src/archive-legs.js"
import { describe, expect, test } from "bun:test"

const chip = (
  phase: string,
  status: string,
  durationMs: number | null = null,
) => ({
  phase,
  label: `${phase}: ${status}`,
  status,
  durationMs,
})

describe("planArchiveLegs", () => {
  test("complete with PR shows BUILD / REVIEW / PR done legs (single PR-lane chip)", () => {
    const legs = planArchiveLegs({
      status: "COMPLETE",
      state: "COMPLETE",
      pullRequestNumber: 700,
      completionSummary: null,
      lifecycleLabels: [
        chip("IMPLEMENT", "SUCCEEDED", 14 * 60_000),
        chip("REVIEW", "SUCCEEDED", 6 * 60_000),
        chip("GITHUB_STATUS_CHECKS", "SUCCEEDED", 2 * 60_000),
        chip("MERGE_PR", "SUCCEEDED", 60_000),
      ],
    })
    expect(legs.map((leg) => [leg.label, leg.kind, leg.lane])).toEqual([
      ["BUILD", "done", "build"],
      ["REVIEW", "done", "review"],
      ["PR", "done", "pr"],
    ])
    expect(archiveLegText(legs[0]!)).toBe("BUILD · 14m")
    // Checks + merge durations are summed into one PR leg.
    expect(archiveLegText(legs[2]!)).toBe("PR · 3m")
    expect(legs[2]!.title).toContain("Pull request path")
    // Underlying step chips enable expand on Completed cards.
    expect(legs[0]!.chips.map((c) => c.phase)).toEqual(["IMPLEMENT"])
    expect(legs[1]!.chips.map((c) => c.phase)).toEqual(["REVIEW"])
    expect(legs[2]!.chips.map((c) => c.phase)).toEqual([
      "GITHUB_STATUS_CHECKS",
      "MERGE_PR",
    ])
  })

  test("complete with PR on GitLab labels the PR-lane leg MR", () => {
    const legs = planArchiveLegs({
      status: "COMPLETE",
      state: "COMPLETE",
      pullRequestNumber: 42,
      completionSummary: null,
      forge: "gitlab",
      lifecycleLabels: [
        chip("IMPLEMENT", "SUCCEEDED", 5 * 60_000),
        chip("REVIEW", "SUCCEEDED", 2 * 60_000),
        chip("GITHUB_STATUS_CHECKS", "SUCCEEDED", 30_000),
        chip("MERGE_PR", "SUCCEEDED", 15_000),
      ],
    })
    expect(legs.map((leg) => leg.label)).toEqual(["BUILD", "REVIEW", "MR"])
    expect(archiveLegText(legs[2]!)).toBe("MR · 45s")
    expect(legs[2]!.title).toContain("Merge request path")
  })

  test("complete no-change shows BUILD done and NO PR NEEDED skip", () => {
    const legs = planArchiveLegs({
      status: "COMPLETE",
      state: "COMPLETE",
      pullRequestNumber: null,
      completionSummary: "Already covered — no code change required.",
      lifecycleLabels: [chip("IMPLEMENT", "SUCCEEDED", 10 * 60_000)],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "done"],
      ["NO PR NEEDED", "skip"],
    ])
    expect(archiveLegText(legs[1]!)).toBe("○ NO PR NEEDED")
  })

  test("complete no-change on GitLab shows NO MR NEEDED", () => {
    const legs = planArchiveLegs({
      status: "COMPLETE",
      state: "COMPLETE",
      pullRequestNumber: null,
      completionSummary: "Nothing to do.",
      forge: "gitlab",
      lifecycleLabels: [chip("IMPLEMENT", "SUCCEEDED", 10 * 60_000)],
    })
    expect(legs.map((leg) => leg.label)).toEqual(["BUILD", "NO MR NEEDED"])
  })

  test("abandoned after build shows done BUILD and unreached REVIEW / PR", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [chip("IMPLEMENT", "SUCCEEDED", 11 * 60_000)],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "done"],
      ["REVIEW", "skip"],
      ["PR", "skip"],
    ])
  })

  test("abandoned with no steps shows all unreached", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "skip"],
      ["REVIEW", "skip"],
      ["PR", "skip"],
    ])
  })

  test("failed-then-abandoned renders Attention fail leg then unreached", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [
        chip("IMPLEMENT", "SUCCEEDED", 8 * 60_000),
        chip("REVIEW", "FAILED", 3 * 60_000),
      ],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "done"],
      ["REVIEW", "fail"],
      ["PR", "skip"],
    ])
    expect(archiveLegText(legs[1]!)).toBe("✕ REVIEW · 3m")
  })

  test("failed BUILD then abandoned shows ✕ BUILD and unreached REVIEW / PR", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [chip("IMPLEMENT", "FAILED", 4 * 60_000)],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "fail"],
      ["REVIEW", "skip"],
      ["PR", "skip"],
    ])
  })

  test("failed checks then abandoned is a single ✕ PR leg", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [
        chip("IMPLEMENT", "SUCCEEDED", 10 * 60_000),
        chip("REVIEW", "SUCCEEDED", 5 * 60_000),
        chip("GITHUB_STATUS_CHECKS", "FAILED", 2 * 60_000),
      ],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "done"],
      ["REVIEW", "done"],
      ["PR", "fail"],
    ])
    expect(archiveLegText(legs[2]!)).toBe("✕ PR · 2m")
  })

  test("failed merge after successful checks is a single ✕ PR leg", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [
        chip("IMPLEMENT", "SUCCEEDED", 10 * 60_000),
        chip("REVIEW", "SUCCEEDED", 5 * 60_000),
        chip("GITHUB_STATUS_CHECKS", "SUCCEEDED", 2 * 60_000),
        chip("MERGE_PR", "FAILED", 60_000),
      ],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "done"],
      ["REVIEW", "done"],
      ["PR", "fail"],
    ])
    // Fail duration is the failed merge step only.
    expect(archiveLegText(legs[2]!)).toBe("✕ PR · 1m")
  })

  test("abandoned with REVIEW but missing BUILD chips keeps REVIEW progress", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [chip("REVIEW", "SUCCEEDED", 6 * 60_000)],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "skip"],
      ["REVIEW", "done"],
      ["PR", "skip"],
    ])
  })

  test("failed DECIDE_PR after checks is a single ✕ PR with fail duration", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [
        chip("IMPLEMENT", "SUCCEEDED", 10 * 60_000),
        chip("REVIEW", "SUCCEEDED", 5 * 60_000),
        chip("GITHUB_STATUS_CHECKS", "SUCCEEDED", 2 * 60_000),
        chip("DECIDE_PR_MERGE", "FAILED", 90_000),
      ],
    })
    expect(legs.map((leg) => [leg.label, leg.kind, leg.durationMs])).toEqual([
      ["BUILD", "done", 10 * 60_000],
      ["REVIEW", "done", 5 * 60_000],
      ["PR", "fail", 90_000],
    ])
    expect(archiveLegText(legs[2]!)).toBe("✕ PR · 1m30s")
  })

  test("abandoned after successful checks shows a single done PR leg", () => {
    const legs = planArchiveLegs({
      status: "ABANDONED",
      state: "ABANDONED",
      pullRequestNumber: null,
      completionSummary: null,
      lifecycleLabels: [
        chip("IMPLEMENT", "SUCCEEDED", 10 * 60_000),
        chip("REVIEW", "SUCCEEDED", 5 * 60_000),
        chip("GITHUB_STATUS_CHECKS", "SUCCEEDED", 2 * 60_000),
      ],
    })
    expect(legs.map((leg) => [leg.label, leg.kind])).toEqual([
      ["BUILD", "done"],
      ["REVIEW", "done"],
      ["PR", "done"],
    ])
    expect(archiveLegText(legs[2]!)).toBe("PR · 2m")
  })

  test("formatArchiveLegDuration is compact lowercase without spaces", () => {
    expect(formatArchiveLegDuration(90_000)).toBe("1m30s")
    expect(formatArchiveLegDuration(14 * 60_000)).toBe("14m")
    expect(formatArchiveLegDuration(7 * 60_000 + 27_000)).toBe("7m27s")
    expect(formatArchiveLegDuration(45_000)).toBe("45s")
  })
})

describe("archiveLegLaneStyle", () => {
  test("sets --leg-lane and --leg-on for each archive lane (matches ui.legLane)", () => {
    expect(archiveLegLaneStyle("build")).toEqual({
      "--leg-lane": "var(--lane-build)",
      "--leg-on": "var(--lane-build-ink)",
    })
    expect(archiveLegLaneStyle("review")).toEqual({
      "--leg-lane": "var(--lane-review)",
      "--leg-on": "var(--lane-review-ink)",
    })
    expect(archiveLegLaneStyle("pr")).toEqual({
      "--leg-lane": "var(--lane-pr)",
      "--leg-on": "var(--lane-pr-ink)",
    })
  })
})
