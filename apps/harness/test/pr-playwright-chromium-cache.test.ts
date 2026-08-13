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
  with?: Record<string, string>
}

const E2E_JOB_IDS = [
  "harness-e2e-live-forge",
  "harness-e2e-ui-history",
] as const

type WorkflowDocument = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

type CompositeActionDocument = {
  runs?: {
    using?: string
    steps?: WorkflowStep[]
  }
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
  const withValue = value.with
  return {
    name: asString(value.name),
    id: asString(value.id),
    uses: asString(value.uses),
    run: asString(value.run),
    if: asString(value.if),
    with: isRecord(withValue) ? parseStringFields(withValue) : undefined,
  }
}

const parseSteps = (value: unknown, label: string): WorkflowStep[] => {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be a list`)
  }
  return value.map(parseStep)
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
  const jobs: Record<string, { steps?: WorkflowStep[] }> = {}
  for (const [name, jobValue] of Object.entries(jobsValue)) {
    if (!isRecord(jobValue)) {
      throw new Error(`expected ${name} job to be a mapping`)
    }
    const stepsValue = jobValue.steps
    jobs[name] = {
      steps:
        stepsValue === undefined
          ? undefined
          : parseSteps(stepsValue, `${name} steps`),
    }
  }
  return { jobs }
}

const parseCompositeAction = (value: unknown): CompositeActionDocument => {
  if (!isRecord(value)) {
    throw new Error("expected a composite action document")
  }
  const runsValue = value.runs
  if (runsValue === undefined) {
    return {}
  }
  if (!isRecord(runsValue)) {
    throw new Error("expected runs to be a mapping")
  }
  const stepsValue = runsValue.steps
  return {
    runs: {
      using: asString(runsValue.using),
      steps:
        stepsValue === undefined
          ? undefined
          : parseSteps(stepsValue, "composite steps"),
    },
  }
}

const loadYaml = async (relativePath: string): Promise<unknown> => {
  const text = await readFile(join(workspaceRoot, relativePath), "utf8")
  return Bun.YAML.parse(text)
}

const expandLocalActions = async (
  steps: WorkflowStep[],
): Promise<WorkflowStep[]> => {
  const expanded: WorkflowStep[] = []
  for (const step of steps) {
    const uses = step.uses
    if (uses?.startsWith("./") === true) {
      const actionPath = uses.endsWith("action.yml")
        ? uses.slice(2)
        : join(uses.slice(2), "action.yml")
      const action = parseCompositeAction(await loadYaml(actionPath))
      expanded.push(...(action.runs?.steps ?? []))
      continue
    }
    expanded.push(step)
  }
  return expanded
}

const e2eJobSteps = async (
  jobId: (typeof E2E_JOB_IDS)[number],
): Promise<WorkflowStep[]> => {
  const workflow = parseWorkflow(await loadYaml(".github/workflows/pr.yml"))
  const steps = workflow.jobs?.[jobId]?.steps
  if (steps === undefined) {
    throw new Error(`PR workflow is missing the ${jobId} job steps`)
  }
  return expandLocalActions(steps)
}

describe("PR harness Playwright Chromium cache (issue #996)", () => {
  test("caches Chromium keyed on the resolved Playwright version", async () => {
    for (const jobId of E2E_JOB_IDS) {
      const steps = await e2eJobSteps(jobId)

      const versionStep = steps.find(
        (step) =>
          step.run?.includes("@playwright/test/package.json") === true &&
          step.run.includes("version"),
      )
      expect(versionStep?.id).toBeDefined()

      const cacheStep = steps.find(
        (step) =>
          (step.uses?.startsWith("actions/cache@") === true ||
            step.uses?.startsWith("actions/cache/restore@") === true) &&
          step.with?.path.includes("ms-playwright") === true,
      )
      expect(cacheStep?.with?.path).toContain("ms-playwright")
      expect(cacheStep?.with?.key).toContain("playwright")
      expect(cacheStep?.with?.key).toContain(
        `steps.${versionStep?.id}.outputs.version`,
      )
      expect(cacheStep?.with?.key).not.toContain("github.sha")
      expect(cacheStep?.with?.["restore-keys"]).toBeUndefined()
    }
  })

  test("a cache hit skips the Chromium download and still installs OS deps", async () => {
    for (const jobId of E2E_JOB_IDS) {
      const steps = await e2eJobSteps(jobId)

      const installBrowsers = steps.filter(
        (step) =>
          step.run?.includes("playwright install") === true &&
          step.run.includes("chromium") &&
          !step.run.includes("install-deps"),
      )
      expect(installBrowsers).toHaveLength(1)
      expect(installBrowsers[0]?.if).toContain("cache-hit")
      expect(installBrowsers[0]?.if).toMatch(/!=\s*'true'/)

      const installDeps = steps.filter((step) =>
        step.run?.includes("playwright install-deps"),
      )
      expect(installDeps).toHaveLength(1)
      expect(installDeps[0]?.run).toContain("chromium")
      expect(installDeps[0]?.if).toContain("cache-hit")
      expect(installDeps[0]?.if).toMatch(/==\s*'true'/)
    }
  })

  test("both live e2e suites still run against Chromium after the cache/install steps", async () => {
    const workflow = parseWorkflow(await loadYaml(".github/workflows/pr.yml"))

    const liveForge = workflow.jobs?.["harness-e2e-live-forge"]?.steps
    const uiHistory = workflow.jobs?.["harness-e2e-ui-history"]?.steps
    if (liveForge === undefined || uiHistory === undefined) {
      throw new Error("PR workflow is missing the split live e2e jobs")
    }

    const chromiumReadyIndex = (steps: WorkflowStep[]) =>
      steps.findIndex(
        (step) =>
          step.uses?.includes("playwright-chromium") === true ||
          (step.run?.includes("playwright install") === true &&
            step.run.includes("chromium")),
      )

    const liveForgeChromium = chromiumReadyIndex(liveForge)
    const uiHistoryChromium = chromiumReadyIndex(uiHistory)
    expect(liveForgeChromium).toBeGreaterThanOrEqual(0)
    expect(uiHistoryChromium).toBeGreaterThanOrEqual(0)

    const liveForgeIndex = liveForge.findIndex(
      (step) => step.run?.includes("harness:e2e-live-forge") === true,
    )
    const noBackendIndex = uiHistory.findIndex(
      (step) => step.run?.includes("harness:e2e-no-backend") === true,
    )
    const uiHistoryIndex = uiHistory.findIndex(
      (step) => step.run?.includes("harness:e2e-ui-history") === true,
    )

    expect(liveForgeIndex).toBeGreaterThan(liveForgeChromium)
    expect(noBackendIndex).toBeGreaterThan(uiHistoryChromium)
    expect(uiHistoryIndex).toBeGreaterThan(uiHistoryChromium)
    expect(noBackendIndex).toBeLessThan(uiHistoryIndex)
  })
})
