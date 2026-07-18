#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const schemaPath = join(packageRoot, "schema.graphql")
const outFile = join(packageRoot, "src/type-defs.gen.ts")
const schema = readFileSync(schemaPath, "utf8")

writeFileSync(
  outFile,
  `/** Generated from schema.graphql — do not edit. */
export const typeDefs = ${JSON.stringify(schema)}
`,
)
console.log(`Wrote ${outFile} (${schema.length} chars)`)
