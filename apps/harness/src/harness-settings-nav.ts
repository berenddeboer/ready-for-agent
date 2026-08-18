/**
 * Navigate to the browser-addressable Harness Settings overlay
 * (issues #840 / #1146). Shared by masthead and setup/backend guidance.
 *
 * In-app opens keep the current Pipeline, Repos, or Completed route as the
 * runtime location and mask it with the public `/settings` URL. Direct
 * navigation and refresh still use the canonical `/settings` route.
 */

import type { NavigateOptions, RegisteredRouter } from "@tanstack/react-router"
import {
  type HarnessSettingsHistoryState,
  markHarnessSettingsOpenedFromInApp,
} from "./routed-dialog.js"

type SettingsTo = "/settings"

type SettingsNavigate = (
  options: NavigateOptions<RegisteredRouter, string, ".", string, SettingsTo>,
) => unknown

export const openHarnessSettings = (input: {
  readonly navigate: SettingsNavigate
}): unknown => {
  markHarnessSettingsOpenedFromInApp()
  const marker: HarnessSettingsHistoryState = { kind: "in-app-origin" }

  return input.navigate({
    // Keep the current surface as the runtime route. Root chrome reads the
    // public Settings request from location.maskedLocation.
    to: ".",
    search: (prev) => prev,
    state: (prev) =>
      Object.assign({}, prev, {
        harnessSettings: marker,
      }),
    mask: {
      to: "/settings",
      // Page belongs to the retained runtime location, not the public
      // Settings URL. Only the root theme pin is shareable here.
      search: (prev) => ({ theme: prev.theme }),
      unmaskOnReload: true,
    },
    resetScroll: false,
  })
}
