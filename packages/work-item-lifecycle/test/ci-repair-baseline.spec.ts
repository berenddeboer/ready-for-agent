import {
  ciRepairBaselineEvent,
  failurePassesCiRepairBaseline,
} from "../src/lib/ci-repair-baseline.js"
import { describe, expect, it } from "bun:test"

const failure = {
  definitionIdentity: "build",
  runIdentity: "11:1",
  orderKey: "00000000000000000011:000001",
}

describe("CI Repair Baseline", () => {
  it("treats a missing baseline as eligible", () => {
    expect(failurePassesCiRepairBaseline({ failure, baseline: null })).toBe(
      true,
    )
  })

  it("lets the merge-commit run itself start a repair, and not an older one", () => {
    const baseline = {
      definitionIdentity: "build",
      runIdentity: "11:1",
      orderKey: "00000000000000000011:000001",
      inclusive: true,
      floorOrderKey: null,
      suppressThroughRunIdentity: null,
      suppressThroughOrderKey: null,
    }
    expect(failurePassesCiRepairBaseline({ failure, baseline })).toBe(true)
    expect(
      failurePassesCiRepairBaseline({
        failure: {
          ...failure,
          runIdentity: "10:1",
          orderKey: "00000000000000000010:000001",
        },
        baseline,
      }),
    ).toBe(false)
  })

  it("does not retrigger the no-change run, and does retrigger a rerun", () => {
    const baseline = {
      definitionIdentity: "build",
      runIdentity: "10:1",
      orderKey: "00000000000000000010:000001",
      inclusive: false,
      floorOrderKey: null,
      suppressThroughRunIdentity: null,
      suppressThroughOrderKey: null,
    }
    expect(
      failurePassesCiRepairBaseline({
        failure: {
          ...failure,
          runIdentity: "10:1",
          orderKey: "00000000000000000010:000001",
        },
        baseline,
      }),
    ).toBe(false)
    expect(
      failurePassesCiRepairBaseline({
        failure: {
          ...failure,
          runIdentity: "10:2",
          orderKey: "00000000000000000010:000002",
        },
        baseline,
      }),
    ).toBe(true)
  })

  it("does not loop a baseline recorded before order keys existed", () => {
    const baseline = {
      definitionIdentity: "build",
      runIdentity: "10:1",
      orderKey: null,
      inclusive: false,
      floorOrderKey: null,
      suppressThroughRunIdentity: null,
      suppressThroughOrderKey: null,
    }
    expect(
      failurePassesCiRepairBaseline({
        failure: {
          ...failure,
          runIdentity: "10:1",
          orderKey: null,
        },
        baseline,
      }),
    ).toBe(false)
    expect(
      failurePassesCiRepairBaseline({
        failure: {
          ...failure,
          runIdentity: "11:1",
          orderKey: "00000000000000000011:000001",
        },
        baseline,
      }),
    ).toBe(false)
  })

  it("blocks the abandoned failure and allows a newer one", () => {
    const baseline = {
      definitionIdentity: "build",
      runIdentity: null,
      orderKey: null,
      inclusive: false,
      floorOrderKey: null,
      suppressThroughRunIdentity: "10:1",
      suppressThroughOrderKey: "00000000000000000010:000001",
    }
    expect(
      failurePassesCiRepairBaseline({
        failure: {
          ...failure,
          runIdentity: "10:1",
          orderKey: "00000000000000000010:000001",
        },
        baseline,
      }),
    ).toBe(false)
    expect(failurePassesCiRepairBaseline({ failure, baseline })).toBe(true)
  })

  it("names merge and no-change from the lifecycle step", () => {
    expect(
      ciRepairBaselineEvent({
        origin: "ci_repair",
        step: "merge_pr",
        nextState: "local_cleanup",
        ownedPrMerged: false,
      })._tag,
    ).toBe("merged")
    expect(
      ciRepairBaselineEvent({
        origin: "ci_repair",
        step: "assess_changes",
        nextState: "local_cleanup",
        ownedPrMerged: false,
      })._tag,
    ).toBe("no_change")
    expect(
      ciRepairBaselineEvent({
        origin: "issue",
        step: "merge_pr",
        nextState: "local_cleanup",
        ownedPrMerged: false,
      })._tag,
    ).toBe("none")
  })
})
