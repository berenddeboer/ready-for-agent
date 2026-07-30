import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { DataFactory, Parser, Store, type Term } from "n3"

const namespace = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rfa: "https://ready-for-agent.dev/ontology/rfa#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
} as const

const iri = (value: string) => DataFactory.namedNode(value)
const term = (localName: string) => iri(`${namespace.rfa}${localName}`)

const rdfType = iri(`${namespace.rdf}type`)
const skosNotation = iri(`${namespace.skos}notation`)
const operationalLifecycleStep = term("OperationalLifecycleStep")
const terminalWorkItemState = term("TerminalWorkItemState")
const transitionClass = term("Transition")
const fromStep = term("fromStep")
const toStep = term("toStep")
const guard = term("guard")
const reasonCode = term("reasonCode")
const agentFree = term("agentFree")
const maximumDuration = term("maximumDuration")
const retryable = term("retryable")
const xsdBoolean = iri(`${namespace.xsd}boolean`)
const xsdDayTimeDuration = iri(`${namespace.xsd}dayTimeDuration`)

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

const onlyObject = (store: Store, subject: Term, predicate: Term): Term => {
  const objects = store.getObjects(subject, predicate, null)
  if (objects.length !== 1) {
    throw new Error(
      `${subject.value} must have exactly one ${predicate.value}; found ${objects.length}`,
    )
  }
  const object = objects[0]
  if (object === undefined) {
    throw new Error(
      `${subject.value} is missing required ${predicate.value} despite its validated count`,
    )
  }
  return object
}

const onlyLiteral = (store: Store, subject: Term, predicate: Term): string => {
  const object = onlyObject(store, subject, predicate)
  if (object.termType !== "Literal" || object.value.length === 0) {
    throw new Error(
      `${subject.value} must have a non-empty literal ${predicate.value}`,
    )
  }
  return object.value
}

const onlyTypedLiteral = (
  store: Store,
  subject: Term,
  predicate: Term,
  datatype: Term,
) => {
  const object = onlyObject(store, subject, predicate)
  if (
    object.termType !== "Literal" ||
    object.datatype.value !== datatype.value
  ) {
    throw new Error(
      `${subject.value} must have a ${datatype.value} literal ${predicate.value}`,
    )
  }
  return object.value
}

const onlyBoolean = (store: Store, subject: Term, predicate: Term): boolean => {
  const value = onlyTypedLiteral(
    store,
    subject,
    predicate,
    xsdBoolean,
  ).toLowerCase()
  if (value !== "true" && value !== "false" && value !== "1" && value !== "0") {
    throw new Error(
      `${subject.value} has invalid boolean ${predicate.value}: ${value}`,
    )
  }
  return value === "true" || value === "1"
}

const durationToMilliseconds = (subject: Term, value: string): number => {
  const match = value.match(
    /^P(?=.*[1-9])(?:([0-9]{1,3})D)?(?:T(?:([0-9]{1,3})H)?(?:([0-9]{1,3})M)?(?:([0-9]{1,3}(?:[.][0-9]{1,3})?)S)?)?$/,
  )
  if (
    match === null ||
    value.endsWith("T") ||
    match.slice(1).every((part) => part === undefined)
  ) {
    throw new Error(
      `${subject.value} has unsupported maximum duration: ${value}`,
    )
  }

  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match
  const milliseconds =
    Number(days) * 86_400_000 +
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000

  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(
      `${subject.value} maximum duration must be a positive whole number of milliseconds: ${value}`,
    )
  }
  return milliseconds
}

interface GeneratedStepProperties {
  readonly step: string
  readonly agentFree: boolean
  readonly maximumDurationMs: number
  readonly retryable: boolean
}

const stepProperties = (store: Store): readonly GeneratedStepProperties[] =>
  store
    .getSubjects(rdfType, operationalLifecycleStep, null)
    .map(
      (subject): GeneratedStepProperties => ({
        step: onlyNotation(store, subject),
        agentFree: onlyBoolean(store, subject, agentFree),
        maximumDurationMs: durationToMilliseconds(
          subject,
          onlyTypedLiteral(store, subject, maximumDuration, xsdDayTimeDuration),
        ),
        retryable: onlyBoolean(store, subject, retryable),
      }),
    )
    .sort((left, right) => left.step.localeCompare(right.step))

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

interface GeneratedTransition {
  readonly from: string
  readonly to: string
  readonly guard: string
  readonly reasonCode: string
}

const transitions = (
  store: Store,
  operationalSteps: readonly string[],
  terminalStates: readonly string[],
): readonly GeneratedTransition[] => {
  const stateSet = new Set([...operationalSteps, ...terminalStates])
  const values = store
    .getSubjects(rdfType, transitionClass, null)
    .map((subject): GeneratedTransition => {
      const from = onlyNotation(store, onlyObject(store, subject, fromStep))
      const to = onlyNotation(store, onlyObject(store, subject, toStep))
      const transitionReasonCode = onlyNotation(
        store,
        onlyObject(store, subject, reasonCode),
      )

      if (!stateSet.has(from)) {
        throw new Error(
          `${subject.value} from-step ${from} is not a Work Item state`,
        )
      }
      if (!stateSet.has(to)) {
        throw new Error(
          `${subject.value} to-step ${to} is not a Work Item state`,
        )
      }

      return {
        from,
        to,
        guard: onlyLiteral(store, subject, guard),
        reasonCode: transitionReasonCode,
      }
    })
    .sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to) ||
        left.guard.localeCompare(right.guard) ||
        left.reasonCode.localeCompare(right.reasonCode),
    )

  if (values.length === 0) {
    throw new Error("No lifecycle transitions found")
  }

  const duplicate = values.find(
    (value, index) =>
      index > 0 && JSON.stringify(value) === JSON.stringify(values[index - 1]),
  )
  if (duplicate !== undefined) {
    throw new Error(
      `Duplicate lifecycle transition: ${duplicate.from} -> ${duplicate.to} (${duplicate.guard})`,
    )
  }

  return values
}

const renderTuple = (name: string, values: readonly string[]) => `\
export const ${name} = [
${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}
] as const
`

const renderTransitions = (values: readonly GeneratedTransition[]) => `\
export interface LifecycleTransition {
  readonly from: WorkItemState
  readonly to: WorkItemState
  readonly guard: string
  readonly reasonCode: string
}

export const LIFECYCLE_TRANSITIONS = [
${values
  .map(
    (value) => `  {
    from: ${JSON.stringify(value.from)},
    to: ${JSON.stringify(value.to)},
    guard: ${JSON.stringify(value.guard)},
    reasonCode: ${JSON.stringify(value.reasonCode)},
  },`,
  )
  .join("\n")}
] as const satisfies readonly LifecycleTransition[]

export const isDeclaredLifecycleTransition = (
  from: WorkItemState,
  to: WorkItemState,
): boolean =>
  LIFECYCLE_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to,
  )
`

const renderStepPropertyMaps = (
  values: readonly GeneratedStepProperties[],
) => `\
export type LifecycleStepPropertyMap<Value> = {
  readonly [Step in OperationalLifecycleStep]: Value
}

export const LIFECYCLE_STEP_AGENT_FREE = {
${values.map((value) => `  ${value.step}: ${value.agentFree},`).join("\n")}
} as const satisfies LifecycleStepPropertyMap<boolean>

export type LifecycleMaxDurations =
  LifecycleStepPropertyMap<Duration.Duration>

export const DEFAULT_LIFECYCLE_MAX_DURATIONS = {
${values
  .map(
    (value) => `  ${value.step}: Duration.millis(${value.maximumDurationMs}),`,
  )
  .join("\n")}
} satisfies LifecycleMaxDurations

export const LIFECYCLE_STEP_RETRYABLE = {
${values.map((value) => `  ${value.step}: ${value.retryable},`).join("\n")}
} as const satisfies LifecycleStepPropertyMap<boolean>

export const isAgentFreeLifecycleStep = (step: string): boolean =>
  Object.hasOwn(LIFECYCLE_STEP_AGENT_FREE, step) &&
  LIFECYCLE_STEP_AGENT_FREE[step as OperationalLifecycleStep]

export const isAgentDependentLifecycleStep = (step: string): boolean =>
  !isAgentFreeLifecycleStep(step)
`

const renderGeneratedSource = (
  operationalSteps: readonly string[],
  terminalStates: readonly string[],
  lifecycleTransitions: readonly GeneratedTransition[],
  lifecycleStepProperties: readonly GeneratedStepProperties[],
) => `\
// This file is generated from ontology/rfa.ttl.
// Run \`bunx nx run lifecycle-model:generate\` to update it.

import { Duration, Schema } from "effect"

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

${renderStepPropertyMaps(lifecycleStepProperties)}
${renderTransitions(lifecycleTransitions)}
`

const generate = async () => {
  const source = await readFile(ontologyPath, "utf8")
  const quads = new Parser({
    baseIRI: `file://${ontologyPath}`,
    format: "Turtle",
  }).parse(source)
  const ontology = new Store(quads)
  const operationalSteps = notationsForClass(ontology, operationalLifecycleStep)
  const terminalStates = notationsForClass(ontology, terminalWorkItemState)
  const lifecycleStepProperties = stepProperties(ontology)

  if (
    lifecycleStepProperties.length !== operationalSteps.length ||
    lifecycleStepProperties.some(
      (properties, index) => properties.step !== operationalSteps[index],
    )
  ) {
    throw new Error(
      "Lifecycle Step properties do not exactly cover the operational state space",
    )
  }

  return renderGeneratedSource(
    operationalSteps,
    terminalStates,
    transitions(ontology, operationalSteps, terminalStates),
    lifecycleStepProperties,
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
