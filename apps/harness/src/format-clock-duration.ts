/** Compact archive chips ("4m15s") vs spaced live labels ("4m 15s"). */
export type ClockDurationStyle = "compact" | "spaced"

/**
 * Formats a duration as clock units (s / m / h).
 *
 * Rounds to the nearest second, clamps negatives to zero, omits trailing
 * zero units, and omits seconds once the duration reaches hour scale.
 */
export function formatClockDuration({
  ms,
  style,
}: {
  readonly ms: number
  readonly style: ClockDurationStyle
}): string {
  const gap = unitGap(style)
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m${gap}${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h${gap}${remainingMinutes}m`
}

function unitGap(style: ClockDurationStyle): string {
  switch (style) {
    case "compact":
      return ""
    case "spaced":
      return " "
    default: {
      const _exhaustive: never = style
      return _exhaustive
    }
  }
}
