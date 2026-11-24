import { type Page, expect } from "@playwright/test"
import { E2E_GRAPHQL_URL } from "../support/constants.ts"
import {
  CONTROL_FILES,
  fakeOpencodeModelCatalog,
  readLiveHarnessState,
  writeControlFile,
} from "../support/live-harness-control.ts"
import { seedLiveHarnessAndRestart } from "../support/live-harness-seed.ts"
import { Given, Then, When } from "./fixtures.ts"

const repositoryId = "repo-01KZW59SEED0REP0FXX0000068"
const parentTitle = "Linear implementation parent"
const parentNumber = 59
const model = "opencode/test-model-a"
const nativeId = (number: number) =>
  `3abca012-1234-4000-8000-${String(number).padStart(12, "0")}`
const displayId = (number: number) => `FIX-${number}`
const issueUrl = (number: number) =>
  `https://linear.app/e2e-fixture/issue/${displayId(number)}`
const rowId = (number: number) => `issue-01KZW59SEED0REP0FXX00000${number}`

// The BER-59 dependency shape, with synthetic tracker identities.
const children = [
  { number: 60, blockers: [] },
  { number: 61, blockers: [] },
  { number: 62, blockers: [61] },
  { number: 63, blockers: [60, 61] },
  { number: 64, blockers: [62, 63] },
  { number: 65, blockers: [62, 63] },
  { number: 66, blockers: [63] },
  { number: 67, blockers: [64, 65, 66] },
]

const insertIssue = (
  number: number,
  blockers: readonly number[] = [],
  state: "OPEN" | "CLOSED" = "OPEN",
): string => {
  const isParent = number === parentNumber
  const now = Date.now()
  return `
    INSERT INTO issue (
      id, repository_id, issue_number, issue_tracker, issue_native_id,
      issue_display_id, title, body, url, state, github_created_at,
      parent_issue_number, parent_issue_url, parent_native_id, parent_display_id,
      has_children, created_at, updated_at
    ) VALUES (
      '${rowId(number)}', '${repositoryId}', ${number}, 'linear', '${nativeId(number)}',
      '${displayId(number)}', '${isParent ? parentTitle : `Child ${displayId(number)}`}',
      '', '${issueUrl(number)}', '${state}', ${now},
      ${isParent ? "NULL, NULL, NULL, NULL" : `${parentNumber}, '${issueUrl(parentNumber)}', '${nativeId(parentNumber)}', '${displayId(parentNumber)}'`},
      ${isParent ? 1 : 0}, ${now}, ${now}
    );
    ${blockers
      .map(
        (blocker) => `INSERT INTO issue_dependency (
          id, issue_id, blocking_issue_number, blocking_issue_url,
          blocking_native_id, blocking_display_id, created_at
        ) VALUES (
          'fixture-dependency-${number}-${blocker}', '${rowId(number)}', ${blocker},
          '${issueUrl(blocker)}', '${nativeId(blocker)}', '${displayId(blocker)}', ${now}
        );`,
      )
      .join("\n")}
  `
}

Given(
  "a Linear parent with eight open children and one closed child in implementation intake",
  async () => {
    writeControlFile(
      readLiveHarnessState(),
      CONTROL_FILES.opencodeModels,
      fakeOpencodeModelCatalog([
        {
          id: "test-model-a",
          providerID: "opencode",
          name: "Test Model A",
          thinkingLevels: ["low", "high"],
        },
      ]),
    )
    const now = Date.now()
    await seedLiveHarnessAndRestart(`
      INSERT INTO repository (
        id, forge, forge_host, project_path, local_path, is_bare, paused,
        issue_tracker, selected_agent_backend, default_model, backend_model_prefs,
        issues_reconciled_at, created_at, updated_at
      ) VALUES (
        '${repositoryId}', 'github', 'github.com', 'e2e/linear-parent',
        '/tmp/e2e-${repositoryId}', 0, 1, 'linear', 'opencode', '${model}',
        '{"opencode":{"defaultModel":"${model}","defaultThinkingLevel":null,"reviewModel":null,"reviewThinkingLevel":null}}',
        ${now}, ${now}, ${now}
      );
      ${insertIssue(parentNumber)}
      ${children.map(({ number, blockers }) => insertIssue(number, blockers)).join("\n")}
      ${insertIssue(68, [], "CLOSED")}
      -- Keep the fixture's admitted jobs queued: this test exercises real
      -- admission and enrollment, not git/agent commands or a live tracker.
      CREATE TRIGGER hold_linear_parent_fixture_jobs AFTER INSERT ON job_queue
      WHEN EXISTS (
        SELECT 1 FROM step_run s JOIN work_item w ON w.id = s.work_item_id
        WHERE s.id = json_extract(NEW.job_payload, '$.stepRunId')
          AND w.repository_id = '${repositoryId}'
      )
      BEGIN
        UPDATE job_queue SET available_at = ${now + 86_400_000} WHERE id = NEW.id;
      END;
    `)
  },
)

const openParentMenu = async (page: Page) => {
  await page
    .getByRole("button", {
      name: `Actions for parent issue ${displayId(parentNumber)}`,
    })
    .click()
  return page.getByRole("menu")
}

When("I submit Implement All With on the Linear parent", async ({ page }) => {
  const menu = await openParentMenu(page)
  await menu
    .getByRole("menuitem", { name: "Implement all with...", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Implement all with..." })
  await expect(
    dialog.getByRole("checkbox", { name: /Implement locally/ }),
  ).toHaveCount(0)
  await dialog.locator('select[name="buildModel"]').selectOption(model)
  await dialog.locator('select[name="buildThinkingLevel"]').selectOption("high")
  await dialog.locator('select[name="mergePolicy"]').selectOption("CLASSIFY")
  await dialog.getByRole("button", { name: "Implement", exact: true }).click()
  await expect(dialog).toBeHidden()
})

type EnrolledWorkItem = {
  id: string
  status: string
  mergePolicy: string
  issueSource: {
    tracker: string
    nativeId: string
    displayId: string
    url: string
  }
  executionProfile: { buildModel: string; buildThinkingLevel: string } | null
}

const enrolledWorkItems = async (page: Page) => {
  const response = await page.request.post(E2E_GRAPHQL_URL, {
    data: {
      query: `query {
        workItems(repositoryId: "${repositoryId}") {
          id status mergePolicy
          issueSource { tracker nativeId displayId url }
          executionProfile { buildModel buildThinkingLevel }
        }
      }`,
    },
  })
  expect(response.ok()).toBe(true)
  const payload: {
    data?: { workItems: EnrolledWorkItem[] }
    errors?: readonly unknown[]
  } = await response.json()
  if (payload.data === undefined || payload.errors !== undefined) {
    throw new Error(
      `Could not read fixture Work Items: ${JSON.stringify(payload.errors)}`,
    )
  }
  return payload.data.workItems.sort((a, b) =>
    a.issueSource.displayId.localeCompare(b.issueSource.displayId),
  )
}

Then(
  "eight Linear children have the chosen profile and policy, and six wait for blockers",
  async ({ page }) => {
    expect(await enrolledWorkItems(page)).toEqual(
      children.map(({ number, blockers }) => ({
        id: expect.any(String),
        status: blockers.length === 0 ? "QUEUED" : "WAITING_FOR_BLOCKERS",
        mergePolicy: "CLASSIFY",
        issueSource: {
          tracker: "linear",
          nativeId: nativeId(number),
          displayId: displayId(number),
          url: issueUrl(number),
        },
        executionProfile: { buildModel: model, buildThinkingLevel: "high" },
      })),
    )
  },
)

Given(
  "two later Linear children, one of which cannot be enrolled",
  async () => {
    await seedLiveHarnessAndRestart(`
    ${insertIssue(69, [60])}
    ${insertIssue(70, [60])}
    CREATE TRIGGER reject_linear_parent_fixture_child BEFORE INSERT ON work_item
    WHEN NEW.repository_id = '${repositoryId}' AND NEW.issue_native_id = '${nativeId(70)}'
    BEGIN
      SELECT RAISE(ABORT, 'Fixture child cannot be enrolled');
    END;
  `)
  },
)

const clickAutoMerge = async (page: Page) => {
  const menu = await openParentMenu(page)
  await menu
    .getByRole("menuitem", { name: "Implement all with auto-merge" })
    .click()
}

Then(
  "failed Linear parent auto-merge leaves the Work Items unchanged",
  async ({ page }) => {
    const before = await enrolledWorkItems(page)
    expect(before).toHaveLength(8)
    await clickAutoMerge(page)
    const parent = page.locator("details").filter({
      has: page.getByRole("link", { name: parentTitle, exact: true }),
    })
    await expect(parent.getByRole("alert")).toBeVisible()
    expect(await enrolledWorkItems(page)).toEqual(before)
  },
)

Given("the later Linear child can now be enrolled", async () => {
  await seedLiveHarnessAndRestart(
    "DROP TRIGGER reject_linear_parent_fixture_child;",
  )
})

Then(
  "Linear parent auto-merge creates and adopts once, including on repeat",
  async ({ page }) => {
    const before = await enrolledWorkItems(page)
    await clickAutoMerge(page)
    await expect
      .poll(async () => (await enrolledWorkItems(page)).length)
      .toBe(10)
    const covered = await enrolledWorkItems(page)
    expect(covered).toEqual([
      ...before.map((item) => ({ ...item, mergePolicy: "ALWAYS" })),
      ...[69, 70].map((number) =>
        expect.objectContaining({
          mergePolicy: "ALWAYS",
          executionProfile: null,
          issueSource: expect.objectContaining({ nativeId: nativeId(number) }),
        }),
      ),
    ])
    const repeated = page.waitForResponse(
      (response) =>
        response.url() === E2E_GRAPHQL_URL &&
        (response.request().postData()?.includes("implementAllWithAutoMerge") ??
          false),
    )
    await clickAutoMerge(page)
    expect(await (await repeated).json()).toMatchObject({
      data: expect.anything(),
    })
    expect(await enrolledWorkItems(page)).toEqual(covered)
  },
)
