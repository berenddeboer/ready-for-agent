import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

describe("Repository settings Merge Policy", () => {
  test("exposes a three-way Merge Policy control instead of Enabled/Disabled Auto-merge", () => {
    const source = indexSource()
    expect(source).toContain('name="mergePolicy"')
    expect(source).toContain(
      "const [mergePolicy, setMergePolicy] = useState(repository.mergePolicy)",
    )
    expect(source).toContain("setMergePolicy(repository.mergePolicy)")
    expect(source).toContain('<option value="OFF">Off — human merge</option>')
    expect(source).toContain('value="CLASSIFY"')
    expect(source).toContain("Classify — risk-assessed merge")
    expect(source).toContain(
      '<option value="ALWAYS">Always — skip classify</option>',
    )
    expect(source).toMatch(
      /updateSettings\.mutate\(\{[\s\S]*mergePolicy,[\s\S]*\}\)/,
    )
    expect(source).toContain("<dt>Merge Policy</dt>")
    expect(source).toContain('? "Always"')
    expect(source).toContain('? "Classify"')
    expect(source).toContain(': "Off"')
    expect(source).not.toContain("Auto-merge")
    expect(source).not.toContain("checked={autoMerge}")
    expect(source).not.toContain("setAutoMerge")
  })
})
