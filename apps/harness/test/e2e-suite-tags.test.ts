import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const featuresDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../e2e/features",
)

const SUITE_TAGS = ["@no-backend", "@live-forge", "@ui-history"] as const

type SuiteTag = (typeof SUITE_TAGS)[number]

const isSuiteTag = (tag: string): tag is SuiteTag =>
  (SUITE_TAGS as readonly string[]).includes(tag)

const parseScenarioSuiteTags = (source: string): string[][] => {
  const featureTags: SuiteTag[] = []
  const scenarios: string[][] = []
  let pending: string[] = []

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim()
    if (line.startsWith("@")) {
      pending.push(
        ...line.split(/\s+/).filter((token) => token.startsWith("@")),
      )
      continue
    }
    if (line.startsWith("Feature:")) {
      featureTags.push(...pending.filter(isSuiteTag))
      pending = []
      continue
    }
    if (line.startsWith("Scenario:") || line.startsWith("Scenario Outline:")) {
      const tags = [...featureTags, ...pending.filter(isSuiteTag)]
      scenarios.push(tags)
      pending = []
    }
  }
  return scenarios
}

describe("live e2e suite tags (issue #999)", () => {
  test("every scenario is tagged with exactly one of @no-backend, @live-forge, @ui-history", async () => {
    const files = (await readdir(featuresDir))
      .filter((name) => name.endsWith(".feature"))
      .slice()
      .sort()
    expect(files.length).toBeGreaterThan(0)

    const untagged: string[] = []
    const overtagged: string[] = []

    for (const name of files) {
      const source = await readFile(join(featuresDir, name), "utf8")
      const scenarios = parseScenarioSuiteTags(source)
      expect(scenarios.length).toBeGreaterThan(0)
      for (const [index, tags] of scenarios.entries()) {
        const unique = [...new Set(tags)]
        if (unique.length === 0) {
          untagged.push(`${name} scenario ${index + 1}`)
        } else if (unique.length > 1) {
          overtagged.push(`${name} scenario ${index + 1}: ${unique.join(" ")}`)
        }
      }
    }

    expect(untagged).toEqual([])
    expect(overtagged).toEqual([])
  })
})
