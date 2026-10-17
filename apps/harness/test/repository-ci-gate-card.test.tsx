import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { ciGateStatusLabel } from "../src/ci-gate-status-label.js"
import {
  RepositoryCiGateCardDetails,
  type RepositoryCiRepairCard,
} from "../src/repository-ci-gate-card.js"
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

  test("GitHub Closed incidents offer start, and other forges do not", () => {
    const closed = gate({
      status: "CLOSED",
      activeIncident: { id: "cfi-1", summary: "CI Gate closed: CI failed." },
    })
    const github = renderToStaticMarkup(
      <RepositoryCiGateCardDetails
        ciGate={closed}
        repairSupported
        onStartRepair={() => undefined}
      />,
    )
    expect(github).toContain("Start CI repair")
    expect(github).toContain('data-ci-repair-action="start"')
    const gitlab = renderToStaticMarkup(
      <RepositoryCiGateCardDetails
        ciGate={closed}
        repairSupported={false}
        onStartRepair={() => undefined}
      />,
    )
    expect(gitlab).not.toContain("Start CI repair")
    expect(gitlab).not.toContain("data-ci-repair-action")
    expect(gitlab).not.toContain("CI repair")
  })

  test("shows queued status without a deadline, then running deadline and links", () => {
    const repair = (
      overrides: Partial<RepositoryCiRepairCard>,
    ): RepositoryCiRepairCard => ({
      incidentId: "cfi-1",
      status: "QUEUED",
      outcome: null,
      launchedAt: null,
      deadlineAt: null,
      report: null,
      localExecutionStopped: false,
      links: [],
      ...overrides,
    })
    const queued = renderToStaticMarkup(
      <RepositoryCiGateCardDetails
        ciGate={gate({
          status: "CLOSED",
          activeIncident: { id: "cfi-1", summary: "CI failed." },
        })}
        repairSupported
        repair={repair({})}
        onStartRepair={() => undefined}
      />,
    )
    expect(queued).toContain("CI repair queued")
    expect(queued).toContain("Deadline starts when the repair launches")
    expect(queued).not.toContain("data-ci-repair-action")

    const running = renderToStaticMarkup(
      <RepositoryCiGateCardDetails
        ciGate={gate({
          status: "CLOSED",
          activeIncident: { id: "cfi-1", summary: "CI failed." },
        })}
        repairSupported
        repair={repair({
          status: "RUNNING",
          launchedAt: "2026-10-17T12:00:00.000Z",
          deadlineAt: "2026-10-17T16:00:00.000Z",
          links: [
            {
              url: "https://github.com/acme/widgets/pull/7",
              kind: "pull_request",
              disposition: "unfinished",
            },
          ],
        })}
        onStartRepair={() => undefined}
      />,
    )
    expect(running).toContain("CI repair running")
    expect(running).toContain("Deadline 2026-10-17T16:00:00.000Z")
    expect(running).toContain("https://github.com/acme/widgets/pull/7")
    expect(running).not.toContain("Local execution stopped.")
  })

  test("an unresolved outcome keeps unfinished work distinct from stopped local execution and offers retry", () => {
    const html = renderToStaticMarkup(
      <RepositoryCiGateCardDetails
        ciGate={gate({
          status: "CLOSED",
          activeIncident: { id: "cfi-1", summary: "CI failed." },
        })}
        repairSupported
        repair={{
          incidentId: "cfi-1",
          status: "UNRESOLVED",
          outcome: "TIMED_OUT",
          launchedAt: "2026-10-17T12:00:00.000Z",
          deadlineAt: "2026-10-17T16:00:00.000Z",
          report:
            "Local execution: stopped.\n\nUnfinished pull requests:\nhttps://github.com/acme/widgets/pull/7",
          localExecutionStopped: true,
          links: [
            {
              url: "https://github.com/acme/widgets/pull/7",
              kind: "pull_request",
              disposition: "unfinished",
            },
            {
              url: "https://github.com/acme/widgets/actions/runs/9",
              kind: "remote_job",
              disposition: "active",
            },
          ],
        }}
        onStartRepair={() => undefined}
      />,
    )
    expect(html).toContain("CI repair timed out")
    expect(html).toContain("Local execution stopped.")
    expect(html).toContain(
      "Unfinished pull requests: https://github.com/acme/widgets/pull/7",
    )
    expect(html).toContain(
      "Active remote jobs: https://github.com/acme/widgets/actions/runs/9",
    )
    expect(html).toContain("Retry CI repair")
    expect(html).toContain('data-ci-repair-action="retry"')
  })
})

describe("repository CI repair entry points", () => {
  test("the issue action and the CI card start repair instead of creating a Work Item", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/home-page-content.tsx"),
      "utf8",
    )
    expect(source).toContain("startRepositoryCiRepair:")
    expect(source).toContain(
      "repairSupported={repository.ciGate.repairSupported}",
    )
    expect(source).toContain("onStartRepair={() => startCiRepair.mutate()}")
    expect(source).toContain("repository.ciGate.repairSupported")
    expect(source).not.toContain("implementCiRepair:")
  })
})
