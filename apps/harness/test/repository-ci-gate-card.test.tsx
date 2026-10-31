import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { ciGateStatusLabel } from "../src/ci-gate-status-label.js"
import type { CiGateStoryInput } from "../src/ci-gate-status-story.js"
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
    expect(html).not.toContain("Active incident")
    expect(html).not.toContain("Last resolved")
    expect(html).not.toContain("Incident history")
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
      expect(html).not.toContain("Active incident")
      expect(html).not.toContain("Last resolved")
      expect(html).toContain("Failure time unavailable")
      expect(html).toContain("Last checked")
      expect(html).toContain("<details")
      expect(html).not.toContain("<details open")
      expect(html).toContain("Incident history")
      const historyAt = html.indexOf("Incident history")
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
    expect(html).not.toContain("CI · success")
    expect(html).not.toContain("Active incident")
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
    expect(html).toContain("Incident history")
    expect(html).toContain("CI Gate recovered: newer success on CI.")
    expect(html).not.toContain("Last resolved")
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
