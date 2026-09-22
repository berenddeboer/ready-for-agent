export const CI_GATE_DISABLED_LABEL = "CI disabled"

export type RepositoryCiGateStatus = "DISABLED" | "OPEN" | "CLOSED" | "DEGRADED"

export const ciGateStatusLabel = (status: RepositoryCiGateStatus): string => {
  switch (status) {
    case "DISABLED":
      return CI_GATE_DISABLED_LABEL
    case "OPEN":
      return "Open"
    case "CLOSED":
      return "Closed"
    case "DEGRADED":
      return "Degraded"
  }
}
