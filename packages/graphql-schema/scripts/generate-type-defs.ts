#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { WORK_ITEM_STATES } from "@ready-for-agent/lifecycle-model"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const schemaTemplatePath = join(packageRoot, "schema.template.graphql")
const schemaPath = join(packageRoot, "schema.graphql")
const outFile = join(packageRoot, "src/type-defs.gen.ts")
const schemaTemplate = readFileSync(schemaTemplatePath, "utf8")
const workItemStateEnumPlaceholder = `enum WorkItemState {
  WORK_ITEM_STATE_VALUES
}`

if (
  schemaTemplate.indexOf(workItemStateEnumPlaceholder) === -1 ||
  schemaTemplate.indexOf(workItemStateEnumPlaceholder) !==
    schemaTemplate.lastIndexOf(workItemStateEnumPlaceholder)
) {
  throw new Error(
    "schema.template.graphql must contain exactly one WorkItemState placeholder enum",
  )
}

const workItemStateValues = WORK_ITEM_STATES.map(
  (state) => `  ${state.toUpperCase()}`,
).join("\n")
const workItemStateEnum = `enum WorkItemState {
${workItemStateValues}
}`
const schema = `# This file is generated from schema.template.graphql and lifecycle-model.
# Run \`bunx nx run graphql-schema:generate\` to update it.

${schemaTemplate.replace(workItemStateEnumPlaceholder, workItemStateEnum)}`

writeFileSync(schemaPath, schema)
writeFileSync(
  outFile,
  `/** Generated from schema.graphql — do not edit. */
export const typeDefs = ${JSON.stringify(schema)}
`,
)
console.log(`Wrote ${outFile} (${schema.length} chars)`)
