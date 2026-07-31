import {
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
  test("complete with PR shows BUILD / REVIEW / CHECKS / MERGE done legs", () => {
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
      ["CHECKS", "done", "pr"],
      ["MERGE", "done", "pr"],
    ])
    expect(archiveLegText(legs[0]!)).toBe("✓ BUILD · 14M")
    expect(archiveLegText(legs[2]!)).toBe("✓ CHECKS · 2M")
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
    expect(archiveLegText(legs[1]!)).toBe("✕ REVIEW · 3M")
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

  test("failed CHECKS then abandoned keeps prior done legs", () => {
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
      ["CHECKS", "fail"],
    ])
  })

  test("failed MERGE after successful CHECKS keeps done CHECKS before ✕ MERGE", () => {
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
      ["CHECKS", "done"],
      ["MERGE", "fail"],
    ])
    expect(archiveLegText(legs[2]!)).toBe("✓ CHECKS · 2M")
    expect(archiveLegText(legs[3]!)).toBe("✕ MERGE · 1M")
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

  test("failed DECIDE_PR after CHECKS uses pr_other duration only on ✕ PR", () => {
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
      ["CHECKS", "done", 2 * 60_000],
      ["PR", "fail", 90_000],
    ])
    expect(archiveLegText(legs[3]!)).toBe("✕ PR · 1M 30S")
  })

  test("abandoned after successful CHECKS only appends unreached MERGE", () => {
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
      ["CHECKS", "done"],
      ["MERGE", "skip"],
    ])
  })

  test("formatArchiveLegDuration uppercases compact duration units", () => {
    expect(formatArchiveLegDuration(90_000)).toBe("1M 30S")
    expect(formatArchiveLegDuration(14 * 60_000)).toBe("14M")
  })
})
