import { renderSpecRequirementChecklist } from "../packages/forge-contract/src/lib/spec-requirement-checklist.js"

const [baselineUrl, checklistFile] = process.argv.slice(2)
if (!baselineUrl || !checklistFile) {
  process.stderr.write(
    "Usage: bun scripts/render-spec-requirement-checklist.ts <approved-baseline-comment-url> <approved-requirements-json-file>\n",
  )
  process.exit(1)
}

process.stdout.write(
  renderSpecRequirementChecklist({
    baselineUrl,
    requirements: await Bun.file(checklistFile).json(),
  }),
)
