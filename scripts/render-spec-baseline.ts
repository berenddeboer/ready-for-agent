import { renderSpecBaseline } from "../packages/forge-contract/src/lib/spec-baseline.js"

const [title, bodyFile, ...designRevisions] = process.argv.slice(2)
if (!title?.trim() || !bodyFile) {
  process.stderr.write(
    "Usage: bun scripts/render-spec-baseline.ts <title> <body-file> [commit-pinned-design-url...]\n",
  )
  process.exit(1)
}

process.stdout.write(
  renderSpecBaseline({
    title,
    body: await Bun.file(bodyFile).text(),
    designRevisions,
  }),
)
