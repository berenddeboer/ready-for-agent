import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import {
  CI_GATE_RESOLVED_HISTORY_WINDOW_MS,
  ciGateRunOrderKey,
} from "@ready-for-agent/forge-contract"
import { ciGateStatusLabel } from "../src/ci-gate-status-label.js"
import {
  type CiGateStoryInput,
  formatIncidentDateTime,
} from "../src/ci-gate-status-story.js"
import { RepositoryCiGateCardDetails } from "../src/repository-ci-gate-card.js"
import { RepositorySettingsCiGateSection } from "../src/repository-settings-ci-gate.js"
import { describe, expect, test } from "bun:test"

const NOW = Date.parse("2026-10-30T23:54:41.329Z")
const LAST_CHECKED = "2026-10-30T23:52:41.329Z"
const FAILURE_DETECTED = "2026-10-30T23:40:41.329Z"

type Story = CiGateStoryInput

const story = (overrides: Partial<Story> = {}): Story => ({
  status: "OPEN",
  observedAt: null,
  defaultBranch: null,
  diagnostic: null,
  definitions: [],
  activeIncident: null,
  incidentHistory: [],
  activeRepair: null,
  canStartCiRepair: false,
  ...overrides,
})

const renderCard = (
  ciGate: Story,
  extras: Partial<Parameters<typeof RepositoryCiGateCardDetails>[0]> = {},
) =>
  renderToStaticMarkup(
    <RepositoryCiGateCardDetails ciGate={ciGate} nowMs={NOW} {...extras} />,
  )

const renderSettings = (
  ciGate: Story,
  extras: Partial<Parameters<typeof RepositorySettingsCiGateSection>[0]> = {},
) =>
  renderToStaticMarkup(
    <RepositorySettingsCiGateSection
      repositoryId="repo-1"
      catalog={{ kind: "loaded", definitions: [], unavailable: [] }}
      selectedIdentities={["ci.yml"]}
      onSelectedIdentitiesChange={() => {}}
      story={ciGate}
      automaticCiRepair={null}
      nowMs={NOW}
      {...extras}
    />,
  )

const storyMarkup = (html: string): string => {
  const start = html.indexOf('data-testid="ci-gate-status"')
  return start < 0 ? html : html.slice(start)
}

describe("ciGateStatusLabel", () => {
  test("names a disabled gate without changing the other statuses", () => {
    expect(ciGateStatusLabel("DISABLED")).toBe("CI disabled")
    expect(ciGateStatusLabel("OPEN")).toBe("Open")
    expect(ciGateStatusLabel("CLOSED")).toBe("Closed")
    expect(ciGateStatusLabel("DEGRADED")).toBe("Degraded")
  })
})

describe("Repository CI Gate presentation", () => {
  test("a disabled gate shows only CI disabled", () => {
    const html = renderCard(
      story({
        status: "DISABLED",
        diagnostic:
          "No CI Gate Definitions selected — Repository CI Gate is disabled.",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        activeIncident: { id: "cfi-old", openedAt: LAST_CHECKED },
        incidentHistory: [
          {
            id: "cfi-resolved",
            openedAt: "2026-10-28T00:00:00.000Z",
            resolvedAt: "2026-10-29T18:00:00.000Z",
            summary: "CI Gate recovered: CI Gate selection cleared.",
            failedRuns: [],
          },
        ],
      }),
    )
    expect(html).toBe("CI disabled")
  })

  test("a closed gate before repair starts offers one start action and the failing run", () => {
    const failingUrl = "https://github.com/acme/widgets/actions/runs/900"
    const ciGate = story({
      status: "CLOSED",
      observedAt: LAST_CHECKED,
      defaultBranch: "trunk",
      canStartCiRepair: true,
      activeIncident: { id: "cfi-open", openedAt: "2026-10-30T23:40:00.000Z" },
      definitions: [
        {
          identity: "ci.yml",
          displayLabel: "CI",
          failureLatched: true,
          diagnostic: null,
          failingRun: {
            runIdentity: "900:1",
            htmlUrl: failingUrl,
            orderKey: "00000000000000000900:000001",
            detectedAt: FAILURE_DETECTED,
          },
          latestRun: {
            runIdentity: "900:1",
            htmlUrl: failingUrl,
            rawStatus: "completed",
            rawConclusion: "failure",
            createdAt: FAILURE_DETECTED,
            updatedAt: FAILURE_DETECTED,
            orderKey: "00000000000000000900:000001",
            earlyJobFailure: false,
          },
        },
        {
          identity: "lint.yml",
          displayLabel: "Lint",
          failureLatched: false,
          diagnostic: "Not observed yet",
          failingRun: null,
          latestRun: null,
        },
      ],
    })
    const html = renderCard(ciGate, { onStartRepair: () => undefined })
    expect(html).toContain("CI Gate · Closed")
    expect(html).toContain(
      "CI failed on trunk. The gate remains closed until recovery is confirmed.",
    )
    expect(html).toContain("Start CI Repair")
    expect(html).toContain('data-testid="ci-repair-action"')
    expect(html).not.toContain("View repair")
    expect(html).toContain("Failing CI · CI")
    expect(html).toContain(`href="${failingUrl}"`)
    expect(html).toContain("Failure detected")
    expect(html).toContain("14 minutes ago")
    expect(html).toContain(`title="${FAILURE_DETECTED}"`)
    expect(html).toContain("Last checked")
    expect(html).toContain("2 minutes ago")
    expect(html).toContain("Current incident")
    expect(html).toContain("Incident opened:")
    const openedBlock = html.slice(
      html.indexOf("Incident opened:"),
      html.indexOf("Failure detected"),
    )
    expect(openedBlock).toContain("2026-10-30T23:40:00.000Z")
    expect(openedBlock).toContain("30 Oct 2026, 23:40 UTC")
    expect(openedBlock).not.toContain(FAILURE_DETECTED)
    expect(html).not.toContain("Active incident")
    expect(html).not.toContain("Last resolved")
    expect(html).not.toContain("Incident history")
    expect(html).toContain("No resolved incidents in the last 7 days")
    expect(html).not.toContain("CI · failure")
    expect(html).toContain("Lint: Not observed yet")
  })

  test("a closed gate with an active repair and an older recovery does not offer start", () => {
    const repairUrl = "https://github.com/acme/widgets/pull/42"
    const failingUrl =
      "https://github.com/acme/widgets/actions/runs/41140957769"
    const previousSuccess = "https://github.com/acme/widgets/actions/runs/100"
    const ciGate = story({
      status: "CLOSED",
      observedAt: LAST_CHECKED,
      defaultBranch: "trunk",
      canStartCiRepair: false,
      activeRepair: {
        workItemId: "wi-repair",
        stateLabel: "Implement",
        statusLabel: "Running",
        htmlUrl: repairUrl,
      },
      activeIncident: { id: "cfi-open", openedAt: "2026-10-30T23:00:00.000Z" },
      incidentHistory: [
        {
          id: "cfi-resolved",
          openedAt: "2026-10-28T00:00:00.000Z",
          resolvedAt: "2026-10-29T18:00:00.000Z",
          summary: "CI Gate recovered: newer success on CI.",
          failedRuns: [
            {
              definitionIdentity: "ci.yml",
              displayLabel: "CI",
              runIdentity: "50:1",
              htmlUrl: "https://github.com/acme/widgets/actions/runs/50",
            },
          ],
        },
      ],
      definitions: [
        {
          identity: "ci.yml",
          displayLabel: "CI",
          failureLatched: true,
          diagnostic: null,
          failingRun: {
            runIdentity: "41140957769:1",
            htmlUrl: failingUrl,
            orderKey: "0000000000041140957769:000001",
            detectedAt: null,
          },
          latestRun: {
            runIdentity: "100:1",
            htmlUrl: previousSuccess,
            rawStatus: "completed",
            rawConclusion: "success",
            createdAt: "2026-10-29T12:00:00.000Z",
            updatedAt: "2026-10-29T12:10:00.000Z",
            orderKey: "00000000000000000100:000001",
            earlyJobFailure: false,
          },
        },
      ],
    })
    const card = renderCard(ciGate, {
      canStartCiRepair: true,
      onStartRepair: () => undefined,
    })
    const settings = renderSettings(ciGate, {
      onStartRepair: () => undefined,
    })
    for (const html of [card, settings]) {
      expect(html).toContain("CI Gate · Closed")
      expect(html).toContain(
        "CI failed on trunk. The gate remains closed until recovery is confirmed.",
      )
      expect(html).toContain("Repair in progress")
      expect(html).toContain("Implement · Running")
      expect(html).toContain("View repair")
      expect(html).toContain(`href="${repairUrl}"`)
      expect(html).not.toContain("Start CI Repair")
      expect(html).not.toContain('data-testid="ci-repair-action"')
      expect(html).toContain("Failing CI · CI")
      expect(html).toContain(`href="${failingUrl}"`)
      expect(html).not.toContain("CI · success")
      expect(html).toContain("Current incident")
      expect(html).toContain("Incident opened:")
      expect(html).toContain("30 Oct 2026, 23:00 UTC")
      expect(html).toContain('dateTime="2026-10-30T23:00:00.000Z"')
      expect(html).not.toContain("Failure detected")
      expect(html).not.toContain("Failure time unavailable")
      expect(html).not.toContain("Active incident")
      expect(html).not.toContain("Last resolved")
      expect(html).toContain("Last checked")
      expect(html).toContain("<details")
      expect(html).not.toContain("<details open")
      expect(html).toContain("Resolved incidents from the last 7 days")
      const historyAt = html.indexOf("Resolved incidents from the last 7 days")
      const recoveryAt = html.indexOf("CI Gate recovered: newer success on CI.")
      expect(recoveryAt).toBeGreaterThan(historyAt)
      expect(html).toContain("Successful run · CI")
      expect(html).toContain(`href="${previousSuccess}"`)
      expect(html).toContain("29 Oct 2026")
    }
    expect(storyMarkup(card)).toContain("CI Gate · Closed")
    expect(storyMarkup(settings)).toContain("CI Gate · Closed")
  })

  test("recovery verification still pending stays labeled and does not look resolved", () => {
    const verificationUrl = "https://github.com/acme/widgets/actions/runs/901"
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        activeIncident: {
          id: "cfi-open",
          openedAt: "2026-10-30T23:00:00.000Z",
        },
        definitions: [
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: true,
            diagnostic: null,
            failingRun: {
              runIdentity: "900:1",
              htmlUrl: "https://github.com/acme/widgets/actions/runs/900",
              orderKey: "00000000000000000900:000001",
              detectedAt: null,
            },
            latestRun: {
              runIdentity: "901:1",
              htmlUrl: verificationUrl,
              rawStatus: "in_progress",
              rawConclusion: null,
              createdAt: "2026-10-30T23:50:00.000Z",
              updatedAt: "2026-10-30T23:51:00.000Z",
              orderKey: "00000000000000000901:000001",
              earlyJobFailure: false,
            },
          },
        ],
      }),
    )
    expect(html).toContain("Recovery verification is still in progress on CI")
    expect(html).toContain("Recovery verification · CI")
    expect(html).toContain(`href="${verificationUrl}"`)
    expect(html).toContain("Failing CI · CI")
    expect(html).toContain("Current incident")
    expect(html).toContain("Incident opened:")
    expect(html).toContain("30 Oct 2026, 23:00 UTC")
    expect(html).not.toContain("Failure detected")
    expect(html).not.toContain("Failure time unavailable")
    expect(html).toContain("No resolved incidents in the last 7 days")
    expect(html).not.toContain("CI · success")
    expect(html).not.toContain("Active incident")
    expect(html).not.toContain("Resolved incidents from the last 7 days")
    expect(html).not.toContain("Incident history")
  })

  test("an open gate keeps a previous recovery in history", () => {
    const html = renderCard(
      story({
        status: "OPEN",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        incidentHistory: [
          {
            id: "cfi-resolved",
            openedAt: "2026-10-28T00:00:00.000Z",
            resolvedAt: "2026-10-29T18:00:00.000Z",
            summary: "CI Gate recovered: newer success on CI.",
            failedRuns: [],
          },
        ],
        definitions: [
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: false,
            diagnostic: null,
            failingRun: null,
            latestRun: {
              runIdentity: "100:1",
              htmlUrl: "https://github.com/acme/widgets/actions/runs/100",
              rawStatus: "completed",
              rawConclusion: "success",
              createdAt: "2026-10-29T12:00:00.000Z",
              updatedAt: "2026-10-29T12:10:00.000Z",
              orderKey: "00000000000000000100:000001",
              earlyJobFailure: false,
            },
          },
        ],
      }),
    )
    expect(html).toContain("CI Gate · Open")
    expect(html).toContain("Default-branch CI is healthy on trunk.")
    expect(html).not.toContain("Start CI Repair")
    expect(html).not.toContain("Failing CI")
    expect(html).not.toContain("CI · success")
    expect(html).toContain("Resolved incidents from the last 7 days")
    expect(html).toContain("CI Gate recovered: newer success on CI.")
    expect(html).not.toContain("Current incident")
    expect(html).not.toContain("Incident opened:")
    expect(html).not.toContain("Last resolved")
    expect(html).not.toContain("No resolved incidents in the last 7 days")
  })

  test("an open gate does not claim health before a definition is observed", () => {
    const ciGate = story({
      status: "OPEN",
      observedAt: null,
      defaultBranch: "trunk",
      definitions: [
        {
          identity: "ci.yml",
          displayLabel: "CI",
          failureLatched: false,
          diagnostic: "Not observed yet",
          failingRun: null,
          latestRun: null,
        },
      ],
    })
    const card = renderCard(ciGate)
    const settings = renderSettings(ciGate)
    for (const html of [card, settings]) {
      expect(html).toContain("CI Gate · Open")
      expect(html).toContain("No failing run has been recorded on trunk.")
      expect(html).toContain("CI: Not observed yet")
      expect(html).not.toContain("healthy")
    }
  })

  test("a success that does not clear the latch is explained instead of shown as a bare success", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        activeIncident: {
          id: "cfi-open",
          openedAt: "2026-10-30T22:00:00.000Z",
        },
        definitions: [
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: true,
            diagnostic: null,
            failingRun: {
              runIdentity: "900:1",
              htmlUrl: "https://github.com/acme/widgets/actions/runs/900",
              orderKey: null,
              detectedAt: null,
            },
            latestRun: {
              runIdentity: "901:1",
              htmlUrl: "https://github.com/acme/widgets/actions/runs/901",
              rawStatus: "completed",
              rawConclusion: "success",
              createdAt: "2026-10-30T23:30:00.000Z",
              updatedAt: "2026-10-30T23:40:00.000Z",
              orderKey: null,
              earlyJobFailure: false,
            },
          },
        ],
      }),
    )
    expect(html).toContain(
      "A successful run was observed on CI, but it has not cleared the latched failure.",
    )
    expect(html).toContain("Recovery verification · CI")
    expect(html).not.toContain("CI · success")
    expect(html).not.toContain("Active incident")
    expect(html).not.toContain("Last resolved")
  })

  test("a missing failing-run link is stated and not invented", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: null,
        defaultBranch: null,
        definitions: [
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: true,
            diagnostic: null,
            failingRun: {
              runIdentity: "900:1",
              htmlUrl: null,
              orderKey: null,
              detectedAt: null,
            },
            latestRun: null,
          },
        ],
      }),
    )
    expect(html).toContain("Failing CI · CI: run link unavailable")
    expect(html).toContain("Failure time unavailable")
    expect(html).toContain("Last checked: not yet")
    expect(html).not.toContain("href=")
    expect(html).not.toContain("1970")
  })

  test("a pending start disables the button without offering retry", () => {
    const html = renderCard(
      story({ status: "CLOSED", canStartCiRepair: true }),
      {
        repairPending: true,
        onStartRepair: () => undefined,
      },
    )
    expect(html).toContain("Starting...")
    expect(html).toContain("disabled")
    expect(html).not.toContain("Start CI Repair")
    expect(html).not.toContain("Retry CI repair")
  })

  test("an unfinished repair hides start even if the server predicate is stale", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        canStartCiRepair: true,
        activeRepair: {
          workItemId: "wi-repair",
          stateLabel: "Review",
          statusLabel: "Needs human",
          htmlUrl: null,
        },
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain("Repair in progress")
    expect(html).toContain("Repair run link unavailable")
    expect(html).not.toContain("Start CI Repair")
    expect(html).not.toContain("href=")
  })
})

const resolvedIncident = (input: {
  readonly id: string
  readonly openedAt: string
  readonly resolvedAt: string | null
  readonly summary: string
}): CiGateStoryInput["incidentHistory"][number] => ({
  id: input.id,
  openedAt: input.openedAt,
  resolvedAt: input.resolvedAt,
  summary: input.summary,
  failedRuns: [],
})

describe("current CI Failure Incident and resolved history window", () => {
  const openedLongAgo = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString()
  const cutoff = new Date(
    NOW - CI_GATE_RESOLVED_HISTORY_WINDOW_MS,
  ).toISOString()
  const justOutside = new Date(
    NOW - CI_GATE_RESOLVED_HISTORY_WINDOW_MS - 1,
  ).toISOString()

  test("a long-running active incident stays visible and is not treated as resolved history", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        activeIncident: { id: "cfi-long", openedAt: openedLongAgo },
        incidentHistory: [
          resolvedIncident({
            id: "cfi-old",
            openedAt: openedLongAgo,
            resolvedAt: justOutside,
            summary: "CI Gate recovered: older than the window.",
          }),
        ],
        definitions: [
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: true,
            diagnostic: null,
            failingRun: {
              runIdentity: "900:1",
              htmlUrl: "https://github.com/acme/widgets/actions/runs/900",
              orderKey: "00000000000000000900:000001",
              detectedAt: null,
            },
            latestRun: null,
          },
        ],
      }),
    )
    const currentAt = html.indexOf('data-testid="ci-gate-current-incident"')
    const historyAt = html.indexOf("No resolved incidents in the last 7 days")
    expect(currentAt).toBeGreaterThan(-1)
    expect(historyAt).toBeGreaterThan(currentAt)
    expect(html).toContain("Current incident")
    expect(html).toContain("Incident opened:")
    expect(html).toContain(
      formatIncidentDateTime(openedLongAgo) ?? openedLongAgo,
    )
    expect(html).toContain(`dateTime="${openedLongAgo}"`)
    expect(html).not.toContain("Failure time unavailable")
    expect(html).not.toContain("Failure detected")
    expect(html).not.toContain("CI Gate recovered: older than the window.")
    expect(html).not.toContain("Resolved incidents from the last 7 days")
    expect(html).toContain("Failing CI · CI")
  })

  test("an unavailable incident opening time is stated only when that time is missing", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: null,
        defaultBranch: "trunk",
        activeIncident: { id: "cfi-open", openedAt: "not-a-time" },
        definitions: [
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: true,
            diagnostic: null,
            failingRun: {
              runIdentity: "900:1",
              htmlUrl: null,
              orderKey: null,
              detectedAt: null,
            },
            latestRun: null,
          },
        ],
      }),
    )
    expect(html).toContain("Current incident")
    expect(html).toContain("Incident opened: unavailable")
    expect(html).toContain("Failure time unavailable")
    expect(html).not.toContain("Failure detected")
  })

  test("an open gate does not show a current incident and hides history outside the window", () => {
    const html = renderCard(
      story({
        status: "OPEN",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        activeIncident: { id: "cfi-stale", openedAt: openedLongAgo },
        incidentHistory: [
          resolvedIncident({
            id: "cfi-old",
            openedAt: openedLongAgo,
            resolvedAt: justOutside,
            summary: "CI Gate recovered: older than the window.",
          }),
        ],
      }),
    )
    expect(html).toContain("CI Gate · Open")
    expect(html).not.toContain("Current incident")
    expect(html).not.toContain("Incident opened:")
    expect(html).not.toContain("No resolved incidents in the last 7 days")
    expect(html).not.toContain("Resolved incidents from the last 7 days")
    expect(html).not.toContain("CI Gate recovered: older than the window.")
    expect(html).not.toContain("Failure time unavailable")
  })

  test("resolved history keeps the cutoff, recently resolved old incidents, and newest-first order", () => {
    const recentOldOpen = new Date(NOW - 60 * 60 * 1000).toISOString()
    const html = renderCard(
      story({
        status: "OPEN",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        incidentHistory: [
          resolvedIncident({
            id: "cfi-outside",
            openedAt: openedLongAgo,
            resolvedAt: justOutside,
            summary: "Resolved just outside the window.",
          }),
          resolvedIncident({
            id: "cfi-cutoff",
            openedAt: openedLongAgo,
            resolvedAt: cutoff,
            summary: "Resolved at the cutoff.",
          }),
          resolvedIncident({
            id: "cfi-recent-old",
            openedAt: openedLongAgo,
            resolvedAt: recentOldOpen,
            summary: "Resolved recently after an old opening.",
          }),
          resolvedIncident({
            id: "cfi-undated",
            openedAt: openedLongAgo,
            resolvedAt: null,
            summary: "Resolved date missing.",
          }),
        ],
      }),
    )
    expect(html).toContain("Resolved incidents from the last 7 days")
    expect(html).toContain("Resolved recently after an old opening.")
    expect(html).toContain("Resolved at the cutoff.")
    expect(html).not.toContain("Resolved just outside the window.")
    expect(html).not.toContain("Resolved date missing.")
    expect(html).not.toContain("Current incident")
    const recentAt = html.indexOf("Resolved recently after an old opening.")
    const cutoffAt = html.indexOf("Resolved at the cutoff.")
    expect(recentAt).toBeGreaterThan(-1)
    expect(cutoffAt).toBeGreaterThan(recentAt)
    expect(html).not.toContain("No resolved incidents in the last 7 days")
  })

  test("a closed gate with no recent resolved incidents does not look recovered", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        activeIncident: { id: "cfi-open", openedAt: LAST_CHECKED },
        incidentHistory: [],
      }),
    )
    expect(html).toContain("Current incident")
    expect(html).toContain("No resolved incidents in the last 7 days")
    expect(html).not.toContain("Resolved incidents from the last 7 days")
    expect(html).not.toContain("CI Gate recovered")
  })
})

const OBSERVED_RUN_ID = 42706569032
const OBSERVED_FAILING_URL =
  "https://github.com/processfocus/monorepo/actions/runs/42706569032"
const OBSERVED_RERUN_URL =
  "https://github.com/processfocus/monorepo/actions/runs/42706569032/attempts/2"

const latchedWorkflow = (input: {
  readonly identity: string
  readonly displayLabel: string
  readonly runId?: number
  readonly failingAttempt?: number
  readonly latestAttempt?: number
  readonly latestStatus: string
  readonly latestConclusion: string | null
  readonly failingUrl?: string
  readonly latestUrl?: string
  readonly earlyJobFailure?: boolean
}): Story["definitions"][number] => {
  const runId = input.runId ?? OBSERVED_RUN_ID
  const failingAttempt = input.failingAttempt ?? 1
  const latestAttempt = input.latestAttempt ?? failingAttempt
  return {
    identity: input.identity,
    displayLabel: input.displayLabel,
    failureLatched: true,
    diagnostic: null,
    failingRun: {
      runIdentity: `${String(runId)}:${String(failingAttempt)}`,
      htmlUrl: input.failingUrl ?? OBSERVED_FAILING_URL,
      orderKey: ciGateRunOrderKey(runId, failingAttempt),
      detectedAt: FAILURE_DETECTED,
    },
    latestRun: {
      runIdentity: `${String(runId)}:${String(latestAttempt)}`,
      htmlUrl: input.latestUrl ?? OBSERVED_RERUN_URL,
      rawStatus: input.latestStatus,
      rawConclusion: input.latestConclusion,
      createdAt: "2026-10-30T23:50:00.000Z",
      updatedAt: "2026-10-30T23:51:00.000Z",
      orderKey: ciGateRunOrderKey(runId, latestAttempt),
      earlyJobFailure: input.earlyJobFailure ?? false,
    },
  }
}

describe("CI rerun recovery presentation", () => {
  test("a running rerun waits for recovery instead of asking for repair", () => {
    const ciGate = story({
      status: "CLOSED",
      observedAt: LAST_CHECKED,
      defaultBranch: "trunk",
      canStartCiRepair: true,
      activeIncident: { id: "cfi-open", openedAt: "2026-10-30T23:40:00.000Z" },
      definitions: [
        latchedWorkflow({
          identity: "ci.yml",
          displayLabel: "CI",
          latestAttempt: 2,
          latestStatus: "in_progress",
          latestConclusion: null,
        }),
      ],
    })
    const card = renderCard(ciGate, {
      canStartCiRepair: true,
      onStartRepair: () => undefined,
    })
    const settings = renderSettings(ciGate, {
      onStartRepair: () => undefined,
    })
    for (const html of [card, settings]) {
      expect(html).toContain("CI Gate · Closed")
      expect(html).toContain("CI rerun in progress; waiting for recovery.")
      expect(html).not.toContain(
        "CI failed on trunk. The gate remains closed until recovery is confirmed.",
      )
      expect(html).toContain("CI rerun · in progress · CI")
      expect(html).toContain(`href="${OBSERVED_RERUN_URL}"`)
      expect(html).toContain("Failing CI · CI")
      expect(html).toContain(`href="${OBSERVED_FAILING_URL}"`)
      expect(html).not.toContain("Start CI Repair")
      expect(html).not.toContain('data-testid="ci-repair-action"')
    }
  })

  test("a queued rerun says it is queued and does not ask for repair", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        definitions: [
          latchedWorkflow({
            identity: "ci.yml",
            displayLabel: "CI",
            latestAttempt: 2,
            latestStatus: "queued",
            latestConclusion: null,
          }),
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain("CI Gate · Closed")
    expect(html).toContain("CI rerun queued; waiting for recovery.")
    expect(html).toContain("CI rerun · queued · CI")
    expect(html).toContain(`href="${OBSERVED_RERUN_URL}"`)
    expect(html).not.toContain("CI rerun in progress; waiting for recovery.")
    expect(html).not.toContain("Start CI Repair")
  })

  test("a failed rerun returns to repair messaging", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        definitions: [
          latchedWorkflow({
            identity: "ci.yml",
            displayLabel: "CI",
            failingAttempt: 2,
            latestAttempt: 2,
            latestStatus: "completed",
            latestConclusion: "failure",
            latestUrl: OBSERVED_RERUN_URL,
          }),
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain("CI Gate · Closed")
    expect(html).toContain(
      "CI failed on trunk. The gate remains closed until recovery is confirmed.",
    )
    expect(html).toContain("Start CI Repair")
    expect(html).not.toContain("CI rerun")
    expect(html).not.toContain("waiting for recovery")
  })

  test("a newer failed attempt is not described as a recovery wait", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        definitions: [
          latchedWorkflow({
            identity: "ci.yml",
            displayLabel: "CI",
            latestAttempt: 2,
            latestStatus: "completed",
            latestConclusion: "failure",
          }),
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain(
      "CI failed on trunk. The gate remains closed until recovery is confirmed.",
    )
    expect(html).toContain("Start CI Repair")
    expect(html).not.toContain("CI rerun")
  })

  test("a rerun that already has a failed job is not a recovery wait", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        definitions: [
          latchedWorkflow({
            identity: "ci.yml",
            displayLabel: "CI",
            latestAttempt: 2,
            latestStatus: "in_progress",
            latestConclusion: null,
            earlyJobFailure: true,
          }),
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain(
      "CI failed on trunk. The gate remains closed until recovery is confirmed.",
    )
    expect(html).toContain("Start CI Repair")
    expect(html).not.toContain("CI rerun")
  })

  test("a confirmed recovery shows the open gate, not a rerun wait", () => {
    const html = renderCard(
      story({
        status: "OPEN",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: false,
        incidentHistory: [
          {
            id: "cfi-resolved",
            openedAt: "2026-10-30T23:00:00.000Z",
            resolvedAt: LAST_CHECKED,
            summary: "CI Gate recovered: newer success on CI.",
            failedRuns: [],
          },
        ],
        definitions: [
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: false,
            diagnostic: null,
            failingRun: null,
            latestRun: {
              runIdentity: `${String(OBSERVED_RUN_ID)}:2`,
              htmlUrl: OBSERVED_RERUN_URL,
              rawStatus: "completed",
              rawConclusion: "success",
              createdAt: "2026-10-30T23:50:00.000Z",
              updatedAt: LAST_CHECKED,
              orderKey: ciGateRunOrderKey(OBSERVED_RUN_ID, 2),
              earlyJobFailure: false,
            },
          },
        ],
      }),
      { onStartRepair: () => undefined },
    )
    expect(html).toContain("CI Gate · Open")
    expect(html).toContain("Default-branch CI is healthy on trunk.")
    expect(html).toContain("CI Gate recovered: newer success on CI.")
    expect(html).not.toContain("CI rerun")
    expect(html).not.toContain("Start CI Repair")
    expect(html).not.toContain("CI Gate · Closed")
  })

  test("a successful rerun that has not cleared the latch stays actionable", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        definitions: [
          latchedWorkflow({
            identity: "ci.yml",
            displayLabel: "CI",
            latestAttempt: 2,
            latestStatus: "completed",
            latestConclusion: "success",
          }),
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain("CI Gate · Closed")
    expect(html).toContain(
      "A successful result was recorded for the latched failure on CI, but that failure has not cleared.",
    )
    expect(html).toContain("Start CI Repair")
    expect(html).not.toContain("CI rerun")
    expect(html).not.toContain("Default-branch CI is healthy")
  })

  test("a pending rerun on one workflow does not hide the other failure", () => {
    const schoolUrl =
      "https://github.com/processfocus/monorepo/actions/runs/100"
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        definitions: [
          latchedWorkflow({
            identity: "deploy.yml",
            displayLabel: "Deploy demo",
            latestAttempt: 2,
            latestStatus: "in_progress",
            latestConclusion: null,
          }),
          latchedWorkflow({
            identity: "e2e.yml",
            displayLabel: "School E2E tests",
            runId: 100,
            latestStatus: "completed",
            latestConclusion: "failure",
            failingUrl: schoolUrl,
            latestUrl: schoolUrl,
          }),
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain("CI Gate · Closed")
    expect(html).toContain(
      "CI rerun in progress on Deploy demo; waiting for recovery. School E2E tests failed on trunk. The gate remains closed until recovery is confirmed.",
    )
    expect(html).not.toContain("CI rerun in progress; waiting for recovery.")
    expect(html).toContain("CI rerun · in progress · Deploy demo")
    expect(html).toContain(`href="${OBSERVED_RERUN_URL}"`)
    expect(html).toContain("Failing CI · School E2E tests")
    expect(html).toContain("Start CI Repair")
    expect(html).not.toContain("CI rerun · in progress · School E2E tests")
  })

  test("a rerun does not hide recovery verification on another workflow", () => {
    const verificationUrl = "https://github.com/acme/widgets/actions/runs/901"
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        activeIncident: {
          id: "cfi-open",
          openedAt: "2026-10-30T23:00:00.000Z",
        },
        definitions: [
          latchedWorkflow({
            identity: "deploy.yml",
            displayLabel: "Deploy demo",
            latestAttempt: 2,
            latestStatus: "in_progress",
            latestConclusion: null,
          }),
          {
            identity: "ci.yml",
            displayLabel: "CI",
            failureLatched: true,
            diagnostic: null,
            failingRun: {
              runIdentity: "900:1",
              htmlUrl: "https://github.com/acme/widgets/actions/runs/900",
              orderKey: ciGateRunOrderKey(900, 1),
              detectedAt: null,
            },
            latestRun: {
              runIdentity: "901:1",
              htmlUrl: verificationUrl,
              rawStatus: "in_progress",
              rawConclusion: null,
              createdAt: "2026-10-30T23:50:00.000Z",
              updatedAt: "2026-10-30T23:51:00.000Z",
              orderKey: ciGateRunOrderKey(901, 1),
              earlyJobFailure: false,
            },
          },
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain(
      "CI rerun in progress on Deploy demo; waiting for recovery.",
    )
    expect(html).toContain(
      "Recovery verification is still in progress on CI. The gate stays closed until that run succeeds.",
    )
    expect(html).toContain("Recovery verification · CI")
    expect(html).toContain(`href="${verificationUrl}"`)
    expect(html).toContain("Start CI Repair")
    expect(html).not.toContain("CI rerun in progress; waiting for recovery.")
  })

  test("mixed queued and running reruns do not claim every failure is in progress", () => {
    const html = renderCard(
      story({
        status: "CLOSED",
        observedAt: LAST_CHECKED,
        defaultBranch: "trunk",
        canStartCiRepair: true,
        definitions: [
          latchedWorkflow({
            identity: "deploy.yml",
            displayLabel: "Deploy demo",
            latestAttempt: 2,
            latestStatus: "in_progress",
            latestConclusion: null,
          }),
          latchedWorkflow({
            identity: "e2e.yml",
            displayLabel: "School E2E tests",
            runId: 100,
            latestAttempt: 2,
            latestStatus: "queued",
            latestConclusion: null,
            failingUrl:
              "https://github.com/processfocus/monorepo/actions/runs/100",
            latestUrl:
              "https://github.com/processfocus/monorepo/actions/runs/100/attempts/2",
          }),
        ],
      }),
      { canStartCiRepair: true, onStartRepair: () => undefined },
    )
    expect(html).toContain(
      "CI rerun in progress on Deploy demo; CI rerun queued on School E2E tests; waiting for recovery.",
    )
    expect(html).not.toContain("CI rerun in progress; waiting for recovery.")
    expect(html).not.toContain("CI rerun queued; waiting for recovery.")
    expect(html).toContain("CI rerun · in progress · Deploy demo")
    expect(html).toContain("CI rerun · queued · School E2E tests")
    expect(html).not.toContain("Start CI Repair")
    expect(html).toContain("CI Gate · Closed")
  })
})

describe("repository CI repair entry points", () => {
  test("the CI card starts a CI Repair Work Item and the issue action authorizes CI Gate Bypass", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/home-page-content.tsx"),
      "utf8",
    )
    expect(source).toContain("startRepositoryCiRepair:")
    expect(source).toContain(
      "canStartCiRepair={repository.ciGate.canStartCiRepair}",
    )
    expect(source).toContain("onStartRepair={() => startCiRepair.mutate()}")
    expect(source).toContain("repairError={ciRepairStartError}")
    expect(source).not.toContain("repairSupported")
    expect(source).not.toContain("repository.ciGate.repair")
    const issueActionStart = source.indexOf(
      "const implementCiRepair = useMutation",
    )
    const issueAction = source.slice(
      issueActionStart,
      source.indexOf("const implementWith = useMutation", issueActionStart),
    )
    expect(issueAction).toContain("implementCiRepair:")
    expect(issueAction).not.toContain("startRepositoryCiRepair")
  })
})
