import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
)

type WorkflowStep = {
  name?: string
  id?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
}

type WorkflowJob = {
  needs?: string[]
  steps?: WorkflowStep[]
}

type WorkflowDocument = {
  jobs?: Record<string, WorkflowJob>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const parseStringFields = (
  value: Record<string, unknown>,
): Record<string, string> | undefined => {
  const fields: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return undefined
    }
    fields[key] = entry
  }
  return fields
}

const parseStep = (value: unknown): WorkflowStep => {
  if (!isRecord(value)) {
    throw new Error("expected a workflow step object")
  }
  const envValue = value.env
  return {
    name: asString(value.name),
    id: asString(value.id),
    uses: asString(value.uses),
    run: asString(value.run),
    if: asString(value.if),
    env: isRecord(envValue) ? parseStringFields(envValue) : undefined,
  }
}

const parseNeeds = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === "string") {
    return [value]
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("expected needs to be a string or list of strings")
  }
  return value
}

const parseJob = (value: unknown, label: string): WorkflowJob => {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} job to be a mapping`)
  }
  const stepsValue = value.steps
  return {
    needs: parseNeeds(value.needs),
    steps:
      stepsValue === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(stepsValue)) {
              throw new Error(`expected ${label} steps to be a list`)
            }
            return stepsValue.map(parseStep)
          })(),
  }
}

const parseWorkflow = (value: unknown): WorkflowDocument => {
  if (!isRecord(value)) {
    throw new Error("expected a workflow document")
  }
  const jobsValue = value.jobs
  if (jobsValue === undefined) {
    return {}
  }
  if (!isRecord(jobsValue)) {
    throw new Error("expected jobs to be a mapping")
  }
  const jobs: Record<string, WorkflowJob> = {}
  for (const [name, job] of Object.entries(jobsValue)) {
    jobs[name] = parseJob(job, name)
  }
  return { jobs }
}

const loadPrWorkflow = async (): Promise<WorkflowDocument> => {
  const text = await readFile(
    join(workspaceRoot, ".github/workflows/pr.yml"),
    "utf8",
  )
  return parseWorkflow(Bun.YAML.parse(text))
}

const stepMentions = (step: WorkflowStep, needle: string): boolean =>
  step.run?.includes(needle) === true ||
  step.name?.includes(needle) === true ||
  Object.values(step.env ?? {}).some((value) => value.includes(needle))

describe("PR live e2e jobs (issue #999)", () => {
  test("runs live-Forge e2e and UI-history e2e as parallel jobs", async () => {
    const workflow = await loadPrWorkflow()
    const liveForge = workflow.jobs?.["harness-e2e-live-forge"]
    const uiHistory = workflow.jobs?.["harness-e2e-ui-history"]

    expect(liveForge).toBeDefined()
    expect(uiHistory).toBeDefined()
    expect(liveForge?.needs ?? []).not.toContain("harness-e2e-ui-history")
    expect(uiHistory?.needs ?? []).not.toContain("harness-e2e-live-forge")

    expect(
      liveForge?.steps?.some((step) =>
        step.run?.includes("harness:e2e-live-forge"),
      ),
    ).toBe(true)
    expect(
      uiHistory?.steps?.some((step) =>
        step.run?.includes("harness:e2e-ui-history"),
      ),
    ).toBe(true)
  })

  test("the UI-history job does not require the fixture vault or a clone", async () => {
    const workflow = await loadPrWorkflow()
    const steps = workflow.jobs?.["harness-e2e-ui-history"]?.steps
    expect(steps).toBeDefined()

    const mentionsVault = steps?.some(
      (step) =>
        stepMentions(step, "E2E_KEYMAXXER_MASTER_KEY") ||
        stepMentions(step, "KEYMAXXER_MASTER_KEY") ||
        stepMentions(step, "clone"),
    )
    expect(mentionsVault).toBe(false)
    expect(
      steps?.some((step) => step.run?.includes("harness:e2e-live-forge")),
    ).toBe(false)
  })

  test("the vault-free @no-backend suite still runs on a fork-safe job", async () => {
    const workflow = await loadPrWorkflow()
    const uiHistory = workflow.jobs?.["harness-e2e-ui-history"]
    expect(
      uiHistory?.steps?.some((step) =>
        step.run?.includes("harness:e2e-no-backend"),
      ),
    ).toBe(true)
    expect(uiHistory?.needs ?? []).not.toContain("harness-e2e-live-forge")
  })

  test("the uninitialized-Keymaxxer suite still runs on a fork-safe job", async () => {
    const workflow = await loadPrWorkflow()
    const uiHistory = workflow.jobs?.["harness-e2e-ui-history"]
    expect(
      uiHistory?.steps?.some((step) =>
        step.run?.includes("harness:e2e-no-vault"),
      ),
    ).toBe(true)
  })

  test("same-repo PRs fail closed when the live-Forge vault secret is missing", async () => {
    const workflow = await loadPrWorkflow()
    const steps = workflow.jobs?.["harness-e2e-live-forge"]?.steps
    expect(steps).toBeDefined()

    const vaultCheck = steps?.find(
      (step) =>
        step.env?.E2E_KEYMAXXER_MASTER_KEY?.includes(
          "secrets.E2E_KEYMAXXER_MASTER_KEY",
        ) === true || step.run?.includes("E2E_KEYMAXXER_MASTER_KEY") === true,
    )
    expect(vaultCheck?.run).toBeDefined()
    expect(vaultCheck?.run).toContain("github.repository")
    expect(vaultCheck?.run).toMatch(/exit 1/)
    expect(vaultCheck?.run).toContain("head.repo.full_name")
  })

  test("required-check rollup still reflects both e2e jobs", async () => {
    const workflow = await loadPrWorkflow()
    const harness = workflow.jobs?.harness
    expect(harness?.needs).toEqual(
      expect.arrayContaining([
        "harness-e2e-live-forge",
        "harness-e2e-ui-history",
      ]),
    )
    expect(harness?.steps?.some((step) => step.run?.includes("success"))).toBe(
      true,
    )
  })
})
