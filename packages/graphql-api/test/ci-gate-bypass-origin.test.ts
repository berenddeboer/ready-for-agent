import { WORK_ITEM_STATES } from "@ready-for-agent/lifecycle-model"
import { projectWorkItemCiRepair } from "../src/lib/work-item-ci-repair-projection.js"
import { describe, expect, test } from "bun:test"

const gateStatuses = ["disabled", "open", "closed", "degraded"] as const

const project = (input: {
  readonly origin: "issue" | "ci_repair"
  readonly state: (typeof WORK_ITEM_STATES)[number]
  readonly failureCode?: string | null
  readonly gateStatus: (typeof gateStatuses)[number]
  readonly activeIncidentId: string | null
}) =>
  projectWorkItemCiRepair({
    workItem: {
      origin: input.origin,
      state: input.state,
      failureCode: input.failureCode ?? null,
    },
    authorizations: [],
    definitions: [],
    gateStatus: input.gateStatus,
    activeIncidentId: input.activeIncidentId,
  })

describe("CI Gate Bypass availability by Work Item origin", () => {
  test("a CI Repair Work Item cannot be authorized under any state or gate", () => {
    for (const state of WORK_ITEM_STATES) {
      for (const gateStatus of gateStatuses) {
        for (const activeIncidentId of [null, "cfi-closed"]) {
          expect(
            project({
              origin: "ci_repair",
              state,
              gateStatus,
              activeIncidentId,
            }).canAuthorize,
          ).toBe(false)
        }
      }
    }
  })

  test("an ordinary unfinished Work Item can still be authorized while Closed", () => {
    expect(
      project({
        origin: "issue",
        state: "implement",
        gateStatus: "closed",
        activeIncidentId: "cfi-closed",
      }).canAuthorize,
    ).toBe(true)
    expect(
      project({
        origin: "issue",
        state: "needs_human",
        gateStatus: "closed",
        activeIncidentId: "cfi-closed",
      }).canAuthorize,
    ).toBe(true)
  })

  test("ordinary Work Items keep the existing Closed-incident eligibility rules", () => {
    expect(
      project({
        origin: "issue",
        state: "implement",
        gateStatus: "open",
        activeIncidentId: "cfi-closed",
      }).canAuthorize,
    ).toBe(false)
    expect(
      project({
        origin: "issue",
        state: "implement",
        gateStatus: "degraded",
        activeIncidentId: "cfi-closed",
      }).canAuthorize,
    ).toBe(false)
    expect(
      project({
        origin: "issue",
        state: "implement",
        gateStatus: "disabled",
        activeIncidentId: null,
      }).canAuthorize,
    ).toBe(false)
    expect(
      project({
        origin: "issue",
        state: "implement",
        gateStatus: "closed",
        activeIncidentId: null,
      }).canAuthorize,
    ).toBe(false)
    expect(
      project({
        origin: "issue",
        state: "complete",
        gateStatus: "closed",
        activeIncidentId: "cfi-closed",
      }).canAuthorize,
    ).toBe(false)
    expect(
      project({
        origin: "issue",
        state: "failed",
        failureCode: null,
        gateStatus: "closed",
        activeIncidentId: "cfi-closed",
      }).canAuthorize,
    ).toBe(false)
  })
})
