import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { DataFactory, Parser, Store, type Term } from "n3"

const namespace = {
  owl: "http://www.w3.org/2002/07/owl#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rfa: "https://ready-for-agent.dev/ontology/rfa#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
} as const

const iri = (value: string) => DataFactory.namedNode(value)
const term = (localName: string) => iri(`${namespace.rfa}${localName}`)

const rdfType = iri(`${namespace.rdf}type`)
const rdfFirst = iri(`${namespace.rdf}first`)
const rdfRest = iri(`${namespace.rdf}rest`)
const rdfNil = iri(`${namespace.rdf}nil`)
const owlComplementOf = iri(`${namespace.owl}complementOf`)
const owlEquivalentClass = iri(`${namespace.owl}equivalentClass`)
const owlHasValue = iri(`${namespace.owl}hasValue`)
const owlIntersectionOf = iri(`${namespace.owl}intersectionOf`)
const owlOnProperty = iri(`${namespace.owl}onProperty`)
const owlSomeValuesFrom = iri(`${namespace.owl}someValuesFrom`)
const owlUnionOf = iri(`${namespace.owl}unionOf`)
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
const generatedPredicatePath = resolve(
  packageRoot,
  "src/generated/predicate-expressions.ts",
)

const predicateClassNames = [
  "LeafIssue",
  "ImplementableIssue",
  "ActionableIssue",
  "RelevantIssue",
  "UnfinishedWorkItem",
] as const

type PredicateClassName = (typeof predicateClassNames)[number]

type PredicateExpression =
  | { readonly kind: "class"; readonly name: string }
  | {
      readonly kind: "intersection"
      readonly expressions: readonly PredicateExpression[]
    }
  | {
      readonly kind: "union"
      readonly expressions: readonly PredicateExpression[]
    }
  | {
      readonly kind: "hasValue"
      readonly property: string
      readonly value: string | number | boolean
    }
  | {
      readonly kind: "someValueOutside"
      readonly property: string
      readonly excludedValues: readonly string[]
    }

const localName = (value: string): string => {
  if (!value.startsWith(namespace.rfa)) {
    throw new Error(`Expected an rfa: term, received ${value}`)
  }
  return value.slice(namespace.rfa.length)
}

const rdfList = (store: Store, head: Term): readonly Term[] => {
  const values: Term[] = []
  const visited = new Set<string>()
  let cursor = head

  while (!cursor.equals(rdfNil)) {
    if (visited.has(cursor.id)) {
      throw new Error(`Cyclic RDF list at ${cursor.value}`)
    }
    visited.add(cursor.id)
    values.push(onlyObject(store, cursor, rdfFirst))
    cursor = onlyObject(store, cursor, rdfRest)
  }

  return values
}

const literalValue = (subject: Term, value: Term) => {
  if (value.termType !== "Literal") {
    throw new Error(`${subject.value} owl:hasValue must be a literal`)
  }
  if (value.datatype.equals(xsdBoolean)) {
    if (value.value === "true" || value.value === "1") return true
    if (value.value === "false" || value.value === "0") return false
    throw new Error(`${subject.value} has an invalid boolean value`)
  }
  if (value.datatype.value.startsWith(`${namespace.xsd}`)) {
    const number = Number(value.value)
    if (Number.isFinite(number)) return number
  }
  return value.value
}

const parsePredicateExpression = (
  store: Store,
  expression: Term,
): PredicateExpression => {
  if (expression.termType === "NamedNode") {
    return { kind: "class", name: localName(expression.value) }
  }

  const intersection = store.getObjects(expression, owlIntersectionOf, null)
  if (intersection.length === 1 && intersection[0] !== undefined) {
    return {
      kind: "intersection",
      expressions: rdfList(store, intersection[0]).map((entry) =>
        parsePredicateExpression(store, entry),
      ),
    }
  }

  const union = store.getObjects(expression, owlUnionOf, null)
  if (union.length === 1 && union[0] !== undefined) {
    return {
      kind: "union",
      expressions: rdfList(store, union[0]).map((entry) =>
        parsePredicateExpression(store, entry),
      ),
    }
  }

  const property = onlyObject(store, expression, owlOnProperty)
  if (property.termType !== "NamedNode") {
    throw new Error(`${expression.value} owl:onProperty must be an IRI`)
  }

  const hasValues = store.getObjects(expression, owlHasValue, null)
  if (hasValues.length === 1 && hasValues[0] !== undefined) {
    return {
      kind: "hasValue",
      property: localName(property.value),
      value: literalValue(expression, hasValues[0]),
    }
  }

  const someValues = store.getObjects(expression, owlSomeValuesFrom, null)
  if (someValues.length === 1 && someValues[0] !== undefined) {
    const complement = onlyObject(store, someValues[0], owlComplementOf)
    const union = onlyObject(store, complement, owlUnionOf)
    return {
      kind: "someValueOutside",
      property: localName(property.value),
      excludedValues: rdfList(store, union).map((entry) => {
        if (entry.termType !== "NamedNode") {
          throw new Error(`${entry.value} must be a named lifecycle state`)
        }
        return onlyNotation(store, entry)
      }),
    }
  }

  throw new Error(`Unsupported predicate expression at ${expression.value}`)
}

const predicateExpressions = (
  store: Store,
): Readonly<Record<PredicateClassName, PredicateExpression>> =>
  Object.fromEntries(
    predicateClassNames.map((name) => [
      name,
      parsePredicateExpression(
        store,
        onlyObject(store, term(name), owlEquivalentClass),
      ),
    ]),
  ) as Readonly<Record<PredicateClassName, PredicateExpression>>

const renderPredicateExpressions = (
  expressions: Readonly<Record<PredicateClassName, PredicateExpression>>,
) => `\
// This file is generated from the predicate class expressions in ontology/rfa.ttl.
// Run \`bunx nx run lifecycle-model:generate\` to update it.

export type LifecyclePredicateName =
${predicateClassNames.map((name) => `  | ${JSON.stringify(name)}`).join("\n")}

type LifecyclePredicateExpression =
  | { readonly kind: "class"; readonly name: string }
  | {
      readonly kind: "intersection"
      readonly expressions: readonly LifecyclePredicateExpression[]
    }
  | {
      readonly kind: "union"
      readonly expressions: readonly LifecyclePredicateExpression[]
    }
  | {
      readonly kind: "hasValue"
      readonly property: string
      readonly value: string | number | boolean
    }
  | {
      readonly kind: "someValueOutside"
      readonly property: string
      readonly excludedValues: readonly string[]
    }

export interface LifecyclePredicateFacts {
  readonly classes: ReadonlySet<string>
  readonly properties: Readonly<Record<string, string | number | boolean>>
}

const LIFECYCLE_PREDICATE_EXPRESSIONS: Readonly<
  Record<LifecyclePredicateName, LifecyclePredicateExpression>
> = ${JSON.stringify(expressions, null, 2)}

const matchesExpression = (
  expression: LifecyclePredicateExpression,
  facts: LifecyclePredicateFacts,
  evaluating: ReadonlySet<string>,
): boolean => {
  switch (expression.kind) {
    case "class": {
      if (facts.classes.has(expression.name)) return true
      if (!(expression.name in LIFECYCLE_PREDICATE_EXPRESSIONS)) return false
      if (evaluating.has(expression.name)) {
        throw new Error(\`Cyclic lifecycle predicate: \${expression.name}\`)
      }
      return matchesExpression(
        LIFECYCLE_PREDICATE_EXPRESSIONS[
          expression.name as LifecyclePredicateName
        ],
        facts,
        new Set([...evaluating, expression.name]),
      )
    }
    case "intersection":
      return expression.expressions.every((entry) =>
        matchesExpression(entry, facts, evaluating),
      )
    case "union":
      return expression.expressions.some((entry) =>
        matchesExpression(entry, facts, evaluating),
      )
    case "hasValue":
      return facts.properties[expression.property] === expression.value
    case "someValueOutside": {
      const value = facts.properties[expression.property]
      return (
        typeof value === "string" &&
        !expression.excludedValues.includes(value)
      )
    }
  }
}

export const matchesLifecyclePredicateExpression = (
  name: LifecyclePredicateName,
  facts: LifecyclePredicateFacts,
): boolean =>
  matchesExpression(
    LIFECYCLE_PREDICATE_EXPRESSIONS[name],
    facts,
    new Set([name]),
  )
`

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

  return {
    stateSource: renderGeneratedSource(
      operationalSteps,
      terminalStates,
      transitions(ontology, operationalSteps, terminalStates),
      lifecycleStepProperties,
    ),
    predicateSource: renderPredicateExpressions(predicateExpressions(ontology)),
  }
}

const check = process.argv.slice(2).includes("--check")
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--check")

if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`)
}

const generated = await generate()

if (check) {
  const [checkedInStateSource, checkedInPredicateSource] = await Promise.all([
    readFile(generatedPath, "utf8").catch(() => ""),
    readFile(generatedPredicatePath, "utf8").catch(() => ""),
  ])
  if (
    checkedInStateSource !== generated.stateSource ||
    checkedInPredicateSource !== generated.predicateSource
  ) {
    console.error(
      "Generated lifecycle model is stale. Run `bunx nx run lifecycle-model:generate`.",
    )
    process.exitCode = 1
  }
} else {
  await Promise.all([
    mkdir(dirname(generatedPath), { recursive: true }),
    mkdir(dirname(generatedPredicatePath), { recursive: true }),
  ])
  await Promise.all([
    writeFile(generatedPath, generated.stateSource),
    writeFile(generatedPredicatePath, generated.predicateSource),
  ])
}
