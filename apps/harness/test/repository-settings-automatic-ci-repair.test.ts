import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const source = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

describe("Repository settings automatic CI repair", () => {
  test("defaults the GitHub checkbox off, persists it, and keeps manual repair", () => {
    const settings = source()
    expect(settings).toContain("Automatic CI repair")
    expect(settings).toContain('data-testid="automatic-ci-repair"')
    expect(settings).toContain(
      "const [automaticCiRepair, setAutomaticCiRepair] = useState(",
    )
    expect(settings).toContain("repository.automaticCiRepair")
    expect(settings).toContain(
      "setAutomaticCiRepair(repository.automaticCiRepair)",
    )
    expect(settings).toContain("checked={automaticCiRepair}")
    expect(settings).toContain("setAutomaticCiRepair(event.target.checked)")
    expect(settings).toContain(
      'automaticCiRepair: forge === "github" ? automaticCiRepair : false',
    )
    expect(settings).toContain('forge === "github" ? (')
    expect(settings).toContain("startRepositoryCiRepair:")
    expect(settings).toContain("onStartRepair={() => startCiRepair.mutate()}")
    expect(settings).not.toContain("useState(true)")
    const card = readFileSync(
      join(import.meta.dir, "../src/repository-ci-gate-card.tsx"),
      "utf8",
    )
    expect(card).not.toContain("automaticCiRepair")
    expect(card).toContain('data-testid="ci-repair-request-source"')
    expect(card).toContain("Automatic")
    expect(card).toContain("Manual")
  })
})
