/**
 * Live e2e for Repository Intake CLI: candidates → intake → status through
 * the compiled operator binary and real GraphQL endpoint (issue #978).
 */

import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "@playwright/test"
import {
  E2E_GRAPHQL_URL,
  FIXTURE_GITHUB_REPOSITORY,
  GITHUB_SENTINEL_ISSUE_NUMBER,
  GITHUB_SENTINEL_ISSUE_TITLE,
} from "../support/constants.ts"
import { Then, When } from "./fixtures.ts"

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
)

const fixtureSelector = `github.com/${FIXTURE_GITHUB_REPOSITORY}`

/** Bound wait for Create Worktree / failed agent steps before suite cleanup. */
const INTAKE_CLEANUP_TIMEOUT_MS = 90_000

type CliJsonResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly document: unknown
}

class GraphQlRequestError extends Error {
  readonly codes: ReadonlyArray<string>

  constructor(messages: ReadonlyArray<string>, codes: ReadonlyArray<string>) {
    super(`GraphQL errors: ${messages.join("; ")}`)
    this.name = "GraphQlRequestError"
    this.codes = codes
  }
}

const graphqlRequest = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(E2E_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as {
    data?: T
    errors?: ReadonlyArray<{
      message: string
      extensions?: { code?: string }
    }>
  }
  if (payload.errors?.length) {
    throw new GraphQlRequestError(
      payload.errors.map((e) => e.message),
      payload.errors.map((e) => e.extensions?.code ?? ""),
    )
  }
  if (!payload.data) {
    throw new Error("GraphQL response missing data")
  }
  return payload.data
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const parseExactlyOneJsonDocument = (text: string): unknown => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length !== 1) {
    throw new Error(
      `Expected exactly one JSON document, got ${lines.length}:\n${text}`,
    )
  }
  const line = lines[0]
  if (line === undefined) {
    throw new Error(`Expected one JSON document, got empty output:\n${text}`)
  }
  return JSON.parse(line)
}

const runFiniteCli = (args: readonly string[]): CliJsonResult => {
  const result = spawnSync("bun", ["run", "ready-for-agent", ...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      READY_FOR_AGENT_GRAPHQL_URL: E2E_GRAPHQL_URL,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    encoding: "utf8",
    timeout: 120_000,
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (result.error) {
    throw result.error
  }
  // Partial Intake writes success-shaped JSON to stdout with nonzero exit.
  // Command-level failures write error JSON to stderr only.
  const stream = stdout.trim().length > 0 ? stdout : stderr
  let document: unknown
  try {
    document = parseExactlyOneJsonDocument(stream)
  } catch (error) {
    throw new Error(
      [
        `CLI ${args.join(" ")} produced invalid JSON (exit ${result.status}).`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    )
  }
  return {
    status: result.status,
    stdout,
    stderr,
    document,
  }
}

// Scenario timeout comes from playwright.config (SCENARIO_TIMEOUT_MS) and from
// the shared Given "the Harness has no configured Repositories", which calls
// test.setTimeout inside a running test. Do not call test.setTimeout at module
// load — bddgen imports step files outside a test and Playwright throws.

// Reuse add/refresh Given/When/Then from add-and-refresh-repository steps.
// Configure model via settings-browser-history "configured default build model".

When(
  "I run candidates for the Fixture Repository with the CLI",
  async ({ world }) => {
    const result = runFiniteCli(["candidates", fixtureSelector])
    world.intakeCandidatesResult = result
  },
)

When(
  "I run candidates for the Fixture Repository with the CLI again",
  async ({ world }) => {
    const result = runFiniteCli(["candidates", fixtureSelector])
    world.intakeCandidatesRerunResult = result
  },
)

When(
  "I run intake for the Fixture Repository with the CLI",
  async ({ world }) => {
    const result = runFiniteCli(["intake", fixtureSelector])
    world.intakeIntakeResult = result
  },
)

When(
  "I run status for the Fixture Repository with the CLI",
  async ({ world }) => {
    const result = runFiniteCli(["status", fixtureSelector])
    world.intakeStatusResult = result
  },
)

Then(
  "candidates JSON includes the sentinel Issue as IMPLEMENT_NOW",
  async ({ world }) => {
    const result = world.intakeCandidatesResult as CliJsonResult | undefined
    if (result === undefined) {
      throw new Error("candidates CLI result missing from scenario world")
    }
    expect(result.status).toBe(0)
    expect(result.stderr.trim()).toBe("")
    const doc = result.document as {
      command: string
      candidates: ReadonlyArray<{
        issueNumber: number
        title: string
        action: string
      }>
    }
    expect(doc.command).toBe("candidates")
    const sentinel = doc.candidates.find(
      (candidate) => candidate.issueNumber === GITHUB_SENTINEL_ISSUE_NUMBER,
    )
    expect(sentinel).toBeDefined()
    expect(sentinel?.title).toBe(GITHUB_SENTINEL_ISSUE_TITLE)
    expect(sentinel?.action).toBe("IMPLEMENT_NOW")
  },
)

Then(
  "intake JSON creates a Work Item for the sentinel Issue",
  async ({ world }) => {
    const result = world.intakeIntakeResult as CliJsonResult | undefined
    if (result === undefined) {
      throw new Error("intake CLI result missing from scenario world")
    }
    expect(result.stderr.trim()).toBe("")
    const doc = result.document as {
      command: string
      results: ReadonlyArray<{
        issueNumber: number
        outcome: string
        workItem?: { id: string; state: string; status: string }
        error?: { code: string; message: string }
      }>
    }
    expect(doc.command).toBe("intake")
    const repository = (
      result.document as {
        repository?: { id?: string }
      }
    ).repository
    if (typeof repository?.id === "string" && repository.id.length > 0) {
      world.intakeRepositoryId = repository.id
    }
    const createdIds: string[] = []
    for (const entry of doc.results) {
      if (
        entry.outcome === "CREATED" &&
        typeof entry.workItem?.id === "string" &&
        entry.workItem.id.length > 0
      ) {
        createdIds.push(entry.workItem.id)
      }
    }
    world.intakeCreatedWorkItemIds = createdIds
    const sentinel = doc.results.find(
      (entry) => entry.issueNumber === GITHUB_SENTINEL_ISSUE_NUMBER,
    )
    expect(sentinel).toBeDefined()
    expect(sentinel?.outcome).toBe("CREATED")
    expect(sentinel?.workItem?.id).toMatch(/\S/)
    expect(sentinel?.workItem?.state).toMatch(/\S/)
    expect(sentinel?.workItem?.status).toMatch(/\S/)
    // Other fixture Issues may fail or succeed; only require sentinel created
    // and a zero exit when every listed result was created.
    const anyFailed = doc.results.some((entry) => entry.outcome === "FAILED")
    expect(result.status).toBe(anyFailed ? 1 : 0)
    world.intakeCreatedWorkItemId = sentinel?.workItem?.id
  },
)

Then("status JSON includes the sentinel Work Item", async ({ world }) => {
  const result = world.intakeStatusResult as CliJsonResult | undefined
  if (result === undefined) {
    throw new Error("status CLI result missing from scenario world")
  }
  expect(result.status).toBe(0)
  expect(result.stderr.trim()).toBe("")
  const doc = result.document as {
    command: string
    lanes: ReadonlyArray<{
      id: string
      workItems: ReadonlyArray<{
        id: string
        issueNumber: number
        issueTitle: string | null
      }>
    }>
  }
  expect(doc.command).toBe("status")
  expect(doc.lanes).toHaveLength(6)
  const allRows = doc.lanes.flatMap((lane) => lane.workItems)
  const sentinelRow = allRows.find(
    (row) => row.issueNumber === GITHUB_SENTINEL_ISSUE_NUMBER,
  )
  expect(sentinelRow).toBeDefined()
  const expectedId = world.intakeCreatedWorkItemId as string | undefined
  if (expectedId !== undefined) {
    expect(sentinelRow?.id).toBe(expectedId)
  }
})

Then("candidates JSON omits the sentinel Issue", async ({ world }) => {
  const result = world.intakeCandidatesRerunResult as CliJsonResult | undefined
  if (result === undefined) {
    throw new Error("candidates rerun CLI result missing from scenario world")
  }
  expect(result.status).toBe(0)
  const doc = result.document as {
    command: string
    candidates: ReadonlyArray<{ issueNumber: number }>
  }
  expect(doc.command).toBe("candidates")
  expect(
    doc.candidates.some(
      (candidate) => candidate.issueNumber === GITHUB_SENTINEL_ISSUE_NUMBER,
    ),
  ).toBe(false)
})

/**
 * Scenario-local teardown so later e2e scenarios can remove the Repository
 * without waiting on Create Worktree / agent Step Runs left by Intake.
 */
Then("I clean up Work Items created by Intake", async ({ world }) => {
  const workItemIds = [
    ...(world.intakeCreatedWorkItemIds ?? []),
    ...(world.intakeCreatedWorkItemId === undefined
      ? []
      : [world.intakeCreatedWorkItemId]),
  ]
  const uniqueIds = [...new Set(workItemIds)]
  if (uniqueIds.length === 0) {
    return
  }

  const repositoryId = world.intakeRepositoryId
  const deadline = Date.now() + INTAKE_CLEANUP_TIMEOUT_MS

  // Wait until no Work Item for this Repository reports RUNNING (active Step Run).
  if (repositoryId !== undefined) {
    while (Date.now() < deadline) {
      const listed = await graphqlRequest<{
        workItems: ReadonlyArray<{ id: string; status: string }>
      }>(
        `query WorkItems($repositoryId: ID!) {
          workItems(repositoryId: $repositoryId) {
            id
            status
          }
        }`,
        { repositoryId },
      )
      const running = listed.workItems.filter(
        (workItem) => workItem.status === "RUNNING",
      )
      if (running.length === 0) {
        break
      }
      await sleep(500)
    }
  }

  for (const workItemId of uniqueIds) {
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out cleaning up Intake Work Item ${workItemId} after ${INTAKE_CLEANUP_TIMEOUT_MS}ms`,
        )
      }
      try {
        await graphqlRequest(
          `mutation ResetWorkItem($workItemId: ID!) {
            resetWorkItem(workItemId: $workItemId)
          }`,
          { workItemId },
        )
        break
      } catch (error) {
        if (
          error instanceof GraphQlRequestError &&
          (error.codes.includes("ACTIVE_STEP_RUN_EXISTS") ||
            error.codes.includes("WORK_ITEM_NOT_FOUND"))
        ) {
          // Still running, or already gone after a concurrent remove — retry / skip.
          if (error.codes.includes("WORK_ITEM_NOT_FOUND")) {
            break
          }
          await sleep(500)
          continue
        }
        throw error
      }
    }
  }
})
