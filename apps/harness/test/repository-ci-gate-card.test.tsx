import { renderToStaticMarkup } from "react-dom/server"
import { ciGateStatusLabel } from "../src/ci-gate-status-label.js"
import { RepositoryCiGateCardDetails } from "../src/repository-ci-gate-card.js"
import { describe, expect, test } from "bun:test"

const DISABLED_GATE_SENTENCE =
  "No CI Gate Definitions selected — Repository CI Gate is disabled."

type CiGate = Parameters<typeof RepositoryCiGateCardDetails>[0]["ciGate"]

const definition = (
  overrides: Partial<CiGate["definitions"][number]> = {},
): CiGate["definitions"][number] => ({
  identity: "ci.yml",
  displayLabel: "Ready for Agent CI",
  diagnostic: null,
  latestRun: null,
  ...overrides,
})

const gate = (overrides: Partial<CiGate> = {}): CiGate => ({
  status: "OPEN",
  observedAt: null,
  defaultBranch: null,
  diagnostic: null,
  definitions: [],
  activeIncident: null,
  latestResolvedIncident: null,
  ...overrides,
})

const renderCard = (ciGate: CiGate) =>
  renderToStaticMarkup(<RepositoryCiGateCardDetails ciGate={ciGate} />)

describe("ciGateStatusLabel", () => {
  test("names a disabled gate without changing the other statuses", () => {
    expect(ciGateStatusLabel("DISABLED")).toBe("CI disabled")
    expect(ciGateStatusLabel("OPEN")).toBe("Open")
    expect(ciGateStatusLabel("CLOSED")).toBe("Closed")
    expect(ciGateStatusLabel("DEGRADED")).toBe("Degraded")
  })
})

describe("Repository card CI Gate", () => {
  test("a disabled gate shows only CI disabled", () => {
    const html = renderCard(
      gate({
        status: "DISABLED",
        diagnostic: DISABLED_GATE_SENTENCE,
        observedAt: "2026-09-22T02:21:07.785Z",
        defaultBranch: "main",
        definitions: [
          definition({
            diagnostic: "Not observed yet",
            latestRun: {
              htmlUrl: "https://github.com/acme/widgets/actions/runs/200",
              rawConclusion: "failure",
            },
          }),
        ],
        activeIncident: { summary: "CI Gate closed: CI failed." },
        latestResolvedIncident: {
          summary: "CI Gate recovered: CI Gate selection cleared.",
        },
      }),
    )
    expect(html).toBe("CI disabled")
  })

  test("a selected gate keeps status, diagnostic, observation, results, and incidents", () => {
    const html = renderCard(
      gate({
        status: "CLOSED",
        diagnostic: "Repository CI Gate is closed: CI failed.",
        observedAt: "2026-09-22T02:21:07.785Z",
        defaultBranch: "main",
        definitions: [
          definition({
            latestRun: {
              htmlUrl: "https://github.com/acme/widgets/actions/runs/200",
              rawConclusion: "failure",
            },
          }),
          definition({
            identity: "lint.yml",
            displayLabel: "Lint",
            diagnostic: "Not observed yet",
            latestRun: null,
          }),
        ],
        activeIncident: { summary: "CI Gate closed: CI failed." },
        latestResolvedIncident: {
          summary: "CI Gate recovered: newer success on CI.",
        },
      }),
    )
    expect(html).toContain("Closed")
    expect(html).toContain("Repository CI Gate is closed: CI failed.")
    expect(html).toContain("Observed 2026-09-22T02:21:07.785Z on main")
    expect(html).toContain("Ready for Agent CI")
    expect(html).toContain("failure")
    expect(html).toContain("View run")
    expect(html).toContain(
      'href="https://github.com/acme/widgets/actions/runs/200"',
    )
    expect(html).toContain("Lint")
    expect(html).toContain("Not observed yet")
    expect(html).toContain("Active incident: CI Gate closed: CI failed.")
    expect(html).toContain(
      "Last resolved: CI Gate recovered: newer success on CI.",
    )
    expect(html).not.toContain("CI disabled")
    expect(html).not.toContain(DISABLED_GATE_SENTENCE)
  })
})
