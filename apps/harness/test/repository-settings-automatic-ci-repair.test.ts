import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const source = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const sliceBetween = (
  sourceText: string,
  start: string,
  end: string,
): string => {
  const from = sourceText.indexOf(start)
  if (from < 0) {
    throw new Error(`Start marker not found: ${start}`)
  }
  const to = sourceText.indexOf(end, from)
  if (to < 0) {
    throw new Error(`End marker not found after ${start}: ${end}`)
  }
  return sourceText.slice(from, to)
}

describe("Repository settings automatic CI repair", () => {
  test("leaves Options and persists the checkbox for every forge", () => {
    const settings = source()
    const options = sliceBetween(
      settings,
      "repo-sec-options-",
      "repo-sec-agent-",
    )
    expect(options).not.toContain('data-testid="automatic-ci-repair"')
    expect(options).not.toContain("When the gate closes")
    expect(options).not.toContain("Automatically start a CI Repair Work Item")
    expect(options).not.toContain("Automatic CI repair")

    expect(settings).toContain(
      "const [automaticCiRepair, setAutomaticCiRepair] = useState(",
    )
    expect(settings).toContain("repository.automaticCiRepair")
    expect(settings).toContain(
      "setAutomaticCiRepair(repository.automaticCiRepair)",
    )
    expect(settings).toContain("automaticCiRepair,")
    expect(settings).not.toContain(
      'automaticCiRepair: forge === "github" ? automaticCiRepair : false',
    )

    const ciGate = sliceBetween(
      settings,
      "<RepositorySettingsCiGateSection",
      "/>",
    )
    expect(ciGate).toContain("checked: automaticCiRepair")
    expect(ciGate).toContain("onCheckedChange: setAutomaticCiRepair")
    expect(ciGate).not.toContain('forge === "github"')
    expect(ciGate).not.toContain(": null")

    expect(settings).toContain("startRepositoryCiRepair:")
    expect(settings).toContain("onStartRepair={() => startCiRepair.mutate()}")
    expect(settings).not.toContain("useState(true)")
    expect(settings).toContain("<dt>Automatic CI repair</dt>")

    const card = readFileSync(
      join(import.meta.dir, "../src/repository-ci-gate-card.tsx"),
      "utf8",
    )
    const story = readFileSync(
      join(import.meta.dir, "../src/ci-gate-status-story-view.tsx"),
      "utf8",
    )
    expect(card).not.toContain("automaticCiRepair")
    expect(story).toContain("Start CI Repair")
    expect(card).toContain("canStartCiRepair")
    expect(card).not.toContain("Retry CI repair")
    expect(card).not.toContain('data-testid="ci-repair-request-source"')
  })
})
