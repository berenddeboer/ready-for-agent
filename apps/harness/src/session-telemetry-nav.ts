/**
 * Navigate to the browser-addressable Session Telemetry overlay
 * (issues #841 / #843 / #906). Shared by Pipeline, Repos, and Completed.
 *
 * Route key is the owning Work Item ID (ADR 0048). Optional sessionId is only a
 * history-state display hint until the session query resolves.
 */

import type { NavigateOptions, RegisteredRouter } from "@tanstack/react-router"
import {
  type SessionTelemetryHistoryState,
  markSessionTelemetryOpenedFromInApp,
} from "./routed-dialog.js"

type TelemetryTo = "/session/$workItemId/telemetry"

type TelemetryNavigate = (
  options: NavigateOptions<RegisteredRouter, string, ".", string, TelemetryTo>,
) => unknown

export const openSessionTelemetry = (input: {
  readonly navigate: TelemetryNavigate
  readonly workItemId: string
  readonly sessionId?: string | null
}): unknown => {
  markSessionTelemetryOpenedFromInApp()
  const sessionId =
    input.sessionId !== null &&
    input.sessionId !== undefined &&
    input.sessionId.length > 0
      ? input.sessionId
      : undefined
  const marker: SessionTelemetryHistoryState =
    sessionId === undefined
      ? { kind: "in-app-origin" }
      : { kind: "in-app-origin", sessionId }

  return input.navigate({
    // Keep the current surface as the runtime route. Root chrome reads the
    // public telemetry request from location.maskedLocation.
    to: ".",
    search: (prev) => prev,
    state: (prev) =>
      Object.assign({}, prev, {
        sessionTelemetry: marker,
      }),
    mask: {
      to: "/session/$workItemId/telemetry",
      params: { workItemId: input.workItemId },
      // Page belongs to the retained Completed runtime location, not the
      // public telemetry URL. Only the root theme pin is shareable here.
      search: (prev) => ({ theme: prev.theme }),
      unmaskOnReload: true,
    },
    resetScroll: false,
  })
}
