/**
 * CI Gate Bypass actions are for ordinary Work Items. A CI Repair Work Item
 * crosses a Closed Repository CI Gate by origin, so Authorize, any
 * bypass-specific revoke, and any authorization prompt stay hidden regardless
 * of lifecycle state, gate state, or a stale canAuthorize flag.
 */
export const ciGateBypassActionsOffered = (workItem: {
  readonly origin: "ISSUE" | "CI_REPAIR"
  readonly ciRepair: { readonly canAuthorize: boolean }
}): boolean => workItem.origin !== "CI_REPAIR" && workItem.ciRepair.canAuthorize
