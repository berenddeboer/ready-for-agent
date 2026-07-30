import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { DataFactory, Parser, Store, type Term } from "n3"

const namespace = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rfa: "https://ready-for-agent.dev/ontology/rfa#",
  skos: "http://www.w3.org/2004/02/skos/core#",
} as const

const iri = (value: string) => DataFactory.namedNode(value)
const term = (localName: string) => iri(`${namespace.rfa}${localName}`)

const rdfType = iri(`${namespace.rdf}type`)
const skosNotation = iri(`${namespace.skos}notation`)
const operationalLifecycleStep = term("OperationalLifecycleStep")
const terminalWorkItemState = term("TerminalWorkItemState")

const packageRoot = resolve(import.meta.dir, "..")
const ontologyPath = resolve(packageRoot, "../../ontology/rfa.ttl")
const generatedPath = resolve(packageRoot, "src/generated/work-item-state.ts")

const onlyNotation = (store: Store, subject: Term): string => {
  const notations = store.getObjects(subject, skosNotation, null)
  if (notations.length !== 1) {
    throw new Error(
      `${subject.value} must have exactly one skos:notation; found ${notations.length}`,
    )
  }

  const notation = notations[0]
  if (notation?.termType !== "Literal" || notation.value.length === 0) {
    throw new Error(`${subject.value} must have a non-empty literal notation`)
  }

  return notation.value
}

const notationsForClass = (
  store: Store,
  classTerm: Term,
): readonly string[] => {
  const values = store
    .getSubjects(rdfType, classTerm, null)
    .map((subject) => onlyNotation(store, subject))
    .sort()

  if (values.length === 0) {
    throw new Error(`No lifecycle terms found for ${classTerm.value}`)
  }

  const duplicate = values.find((value, index) => value === values[index - 1])
  if (duplicate !== undefined) {
    throw new Error(`Duplicate lifecycle notation: ${duplicate}`)
  }

  return values
}

const renderTuple = (name: string, values: readonly string[]) => `\
export const ${name} = [
${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}
] as const
`

const renderGeneratedSource = (
  operationalSteps: readonly string[],
  terminalStates: readonly string[],
) => `\
// This file is generated from ontology/rfa.ttl.
// Run \`bunx nx run lifecycle-model:generate\` to update it.

import { Schema } from "effect"

${renderTuple("OPERATIONAL_LIFECYCLE_STEPS", operationalSteps)}
export const OperationalLifecycleStep = Schema.Literals(
  OPERATIONAL_LIFECYCLE_STEPS,
)
export type OperationalLifecycleStep =
  typeof OperationalLifecycleStep.Type

${renderTuple("TERMINAL_WORK_ITEM_STATES", terminalStates)}
export const TerminalWorkItemState = Schema.Literals(
  TERMINAL_WORK_ITEM_STATES,
)
export type TerminalWorkItemState = typeof TerminalWorkItemState.Type

export const WORK_ITEM_STATES = [
  ...OPERATIONAL_LIFECYCLE_STEPS,
  ...TERMINAL_WORK_ITEM_STATES,
] as const

export const WorkItemState = Schema.Literals(WORK_ITEM_STATES)
export type WorkItemState = typeof WorkItemState.Type
`

const generate = async () => {
  const source = await readFile(ontologyPath, "utf8")
  const quads = new Parser({
    baseIRI: `file://${ontologyPath}`,
    format: "Turtle",
  }).parse(source)
  const ontology = new Store(quads)

  return renderGeneratedSource(
    notationsForClass(ontology, operationalLifecycleStep),
    notationsForClass(ontology, terminalWorkItemState),
  )
}

const check = process.argv.slice(2).includes("--check")
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--check")

if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`)
}

const generatedSource = await generate()

if (check) {
  const checkedInSource = await readFile(generatedPath, "utf8").catch(() => "")
  if (checkedInSource !== generatedSource) {
    console.error(
      "Generated lifecycle state is stale. Run `bunx nx run lifecycle-model:generate`.",
    )
    process.exitCode = 1
  }
} else {
  await mkdir(dirname(generatedPath), { recursive: true })
  await writeFile(generatedPath, generatedSource)
}
