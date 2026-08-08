export type HarnessSettingsAutoOpenAction = "NONE" | "MARK_ATTEMPTED" | "OPEN"

export const getHarnessSettingsAutoOpenAction = (options: {
  readonly autoOpenAttempted: boolean
  readonly configLoaded: boolean
  readonly buildConfigured: boolean
  readonly backendStatusLoaded: boolean
  readonly defaultBackendUnavailable: boolean
  readonly otherRoutedDialogOpen: boolean
  readonly routedSettingsOpen: boolean
}): HarnessSettingsAutoOpenAction => {
  if (options.autoOpenAttempted || !options.configLoaded) {
    return "NONE"
  }

  const firstRunNeedsSettings = !options.buildConfigured
  const unavailableBackendNeedsSettings =
    options.backendStatusLoaded && options.defaultBackendUnavailable
  if (!firstRunNeedsSettings && !unavailableBackendNeedsSettings) {
    return "NONE"
  }

  // A competing routed overlay suppresses this pass without consuming the
  // page-session attempt. Settings can open after that overlay is dismissed.
  if (options.otherRoutedDialogOpen) {
    return "NONE"
  }

  return options.routedSettingsOpen ? "MARK_ATTEMPTED" : "OPEN"
}
