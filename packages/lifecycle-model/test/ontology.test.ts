import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import type { Term } from "n3"
import { DataFactory, Parser, Store } from "n3"
import SHACLValidator from "rdf-validate-shacl"
import { describe, expect, it } from "bun:test"

const ontologyRoot = resolve(import.meta.dir, "../../../ontology")
const fixturesRoot = resolve(ontologyRoot, "fixtures")
const contextPath = resolve(ontologyRoot, "../CONTEXT.md")

const namespace = {
  owl: "http://www.w3.org/2002/07/owl#",
  prov: "http://www.w3.org/ns/prov#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  rfa: "https://ready-for-agent.dev/ontology/rfa#",
  sh: "http://www.w3.org/ns/shacl#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
} as const

const iri = (value: string) => DataFactory.namedNode(value)
const term = (localName: string) => iri(`${namespace.rfa}${localName}`)

const rdfType = iri(`${namespace.rdf}type`)
const rdfFirst = iri(`${namespace.rdf}first`)
const rdfRest = iri(`${namespace.rdf}rest`)
const rdfNil = iri(`${namespace.rdf}nil`)
const rdfsSubClassOf = iri(`${namespace.rdfs}subClassOf`)
const owlClass = iri(`${namespace.owl}Class`)
const owlAllDisjointClasses = iri(`${namespace.owl}AllDisjointClasses`)
const owlAnnotatedProperty = iri(`${namespace.owl}annotatedProperty`)
const owlAnnotatedSource = iri(`${namespace.owl}annotatedSource`)
const owlAnnotatedTarget = iri(`${namespace.owl}annotatedTarget`)
const owlAxiom = iri(`${namespace.owl}Axiom`)
const owlDisjointWith = iri(`${namespace.owl}disjointWith`)
const owlEquivalentClass = iri(`${namespace.owl}equivalentClass`)
const owlMembers = iri(`${namespace.owl}members`)
const owlNamedIndividual = iri(`${namespace.owl}NamedIndividual`)
const owlObjectProperty = iri(`${namespace.owl}ObjectProperty`)
const owlDatatypeProperty = iri(`${namespace.owl}DatatypeProperty`)
const owlOnProperty = iri(`${namespace.owl}onProperty`)
const owlRestriction = iri(`${namespace.owl}Restriction`)
const owlSomeValuesFrom = iri(`${namespace.owl}someValuesFrom`)
const skosConcept = iri(`${namespace.skos}Concept`)
const skosDefinition = iri(`${namespace.skos}definition`)
const skosHiddenLabel = iri(`${namespace.skos}hiddenLabel`)
const skosNotation = iri(`${namespace.skos}notation`)
const skosPrefLabel = iri(`${namespace.skos}prefLabel`)
const shIn = iri(`${namespace.sh}in`)
const shPath = iri(`${namespace.sh}path`)

const operationalClass = term("OperationalLifecycleStep")
const terminalClass = term("TerminalWorkItemState")
const contextTermClass = term("ContextTerm")
const avoidanceRationale = term("avoidanceRationale")
const maximumDuration = term("maximumDuration")
const xsdDayTimeDuration = iri(`${namespace.xsd}dayTimeDuration`)
const xsdDuration = iri(`${namespace.xsd}duration`)

interface AvoidedLabel {
  readonly label: string
  readonly rationale?: string
}

interface ContextTerm {
  readonly label: string
  readonly definition: string
  readonly avoidedLabels: readonly AvoidedLabel[]
}

const splitOutsideParentheses = (value: string) => {
  const entries: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "(") {
      depth += 1
    } else if (character === ")") {
      depth -= 1
    } else if (character === "," && depth === 0) {
      entries.push(value.slice(start, index).trim())
      start = index + 1
    }
  }

  entries.push(value.slice(start).trim())
  return entries
}

const parseAvoidedLabel = (value: string): AvoidedLabel => {
  const rationaleStart = value.indexOf(" (")
  if (rationaleStart === -1 || !value.endsWith(")")) {
    return { label: value }
  }

  return {
    label: value.slice(0, rationaleStart),
    rationale: value.slice(rationaleStart + 2, -1),
  }
}

const parseContextTerms = (source: string) => {
  const lines = source.split("\n")
  const terms: ContextTerm[] = []

  for (const [index, line] of lines.entries()) {
    const exactHeading = line.match(/^\*\*(.+)\*\*:$/)
    if (exactHeading === null) {
      continue
    }

    const definition = lines[index + 1]
    if (definition === undefined || definition.length === 0) {
      throw new Error(`Missing definition for ${exactHeading[1]}`)
    }

    const avoidLine = lines[index + 2]
    const avoidedLabels =
      avoidLine?.startsWith("_Avoid_: ") === true
        ? splitOutsideParentheses(avoidLine.slice("_Avoid_: ".length)).map(
            parseAvoidedLabel,
          )
        : []

    terms.push({
      label: exactHeading[1]!,
      definition,
      avoidedLabels,
    })
  }

  return terms
}

const expectedOperationalTerms = {
  CreateWorktree: ["create_worktree", "Create Worktree"],
  InstallDependencies: ["install_dependencies", "Install Dependencies"],
  Implement: ["implement", "Implement"],
  AssessChanges: ["assess_changes", "Assess Changes"],
  PreCommit: ["pre_commit", "Pre-Commit"],
  Review: ["review", "Review"],
  Commit: ["commit", "Commit"],
  CreatePr: ["create_pr", "Create PR"],
  WatchPrStatusChecks: ["watch_pr_status_checks", "Watch PR Status Checks"],
  ResolvePrMergeConflict: [
    "resolve_pr_merge_conflict",
    "Resolve PR Merge Conflict",
  ],
  InvestigatePrStatusChecks: [
    "investigate_pr_status_checks",
    "Investigate PR Status Checks",
  ],
  MarkPrReadyForReview: [
    "mark_pr_ready_for_review",
    "Mark PR Ready for Review",
  ],
  DecidePrMerge: ["decide_pr_merge", "Decide PR Merge"],
  MergePr: ["merge_pr", "Merge PR"],
  CloseIssue: ["close_issue", "Close Issue"],
  LocalCleanup: ["local_cleanup", "local cleanup"],
} as const

const expectedTerminalTerms = {
  Complete: ["complete", "Complete"],
  Failed: ["failed", "Failed"],
  NeedsHuman: ["needs_human", "Needs Human"],
  Abandoned: ["abandoned", "Abandoned"],
} as const

const expectedStateIris = [
  ...Object.keys(expectedOperationalTerms),
  ...Object.keys(expectedTerminalTerms),
].map((localName) => `${namespace.rfa}${localName}`)

const parseTurtle = (path: string) => {
  const source = readFileSync(path, "utf8")
  const quads = new Parser({
    baseIRI: `file://${path}`,
    format: "Turtle",
  }).parse(source)

  return new Store(quads)
}

const contextTerms = parseContextTerms(readFileSync(contextPath, "utf8"))
const ontology = new Store(
  readdirSync(ontologyRoot)
    .filter((file) => file.endsWith(".ttl") && file !== "shapes.ttl")
    .sort()
    .flatMap((file) =>
      parseTurtle(resolve(ontologyRoot, file)).getQuads(null, null, null, null),
    ),
)
const shapes = parseTurtle(resolve(ontologyRoot, "shapes.ttl"))

const getOnlyObject = (store: Store, subject: Term, predicate: Term) => {
  const objects = store.getObjects(subject, predicate, null)
  expect(objects).toHaveLength(1)

  const object = objects[0]
  if (object === undefined) {
    throw new Error(`Missing object for ${subject.value} ${predicate.value}`)
  }

  return object
}

const getOnlyLiteral = (store: Store, subject: Term, predicate: Term) => {
  const object = getOnlyObject(store, subject, predicate)
  if (object.termType !== "Literal") {
    throw new Error(
      `Expected a literal for ${subject.value} ${predicate.value}`,
    )
  }

  return object
}

const readRdfList = (store: Store, head: Term) => {
  const values: Term[] = []
  const visited = new Set<string>()
  let current = head

  while (!current.equals(rdfNil)) {
    const key = `${current.termType}:${current.value}`
    if (visited.has(key)) {
      throw new Error(`Cyclic RDF list at ${key}`)
    }
    visited.add(key)

    values.push(getOnlyObject(store, current, rdfFirst))
    current = getOnlyObject(store, current, rdfRest)
  }

  return values
}

const expectExactIris = (actual: Iterable<Term>, expected: string[]) => {
  const actualIris = [...actual].map(({ value }) => value).sort()
  expect(actualIris).toEqual([...expected].sort())
}

interface DisjointnessViolation {
  readonly kind: "class" | "individual"
  readonly subject: string
  readonly disjointClasses: readonly [string, string]
}

const namedIri = (value: Term, context: string) => {
  if (value.termType !== "NamedNode") {
    throw new Error(`${context} must be a named IRI, got ${value.termType}`)
  }

  return value.value
}

const pairKey = (first: string, second: string) =>
  [first, second].sort().join("\u0000")

const superclassClosure = (store: Store, classIri: string) => {
  const closure = new Set([classIri])
  const pending = [classIri]

  for (const current of pending) {
    for (const parent of store.getObjects(iri(current), rdfsSubClassOf, null)) {
      if (parent.termType !== "NamedNode") {
        continue
      }
      const parentIri = parent.value
      if (!closure.has(parentIri)) {
        closure.add(parentIri)
        pending.push(parentIri)
      }
    }
  }

  return closure
}

const findDisjointnessViolations = (store: Store) => {
  const disjointPairs = new Set<string>()
  const classes = new Set<string>()

  const addDisjointPair = (first: string, second: string) => {
    classes.add(first)
    classes.add(second)
    disjointPairs.add(pairKey(first, second))
  }

  for (const quad of store.getQuads(null, owlDisjointWith, null, null)) {
    addDisjointPair(
      namedIri(quad.subject, "owl:disjointWith subject"),
      namedIri(quad.object, "owl:disjointWith object"),
    )
  }

  for (const axiom of store.getSubjects(rdfType, owlAllDisjointClasses, null)) {
    const members = readRdfList(
      store,
      getOnlyObject(store, axiom, owlMembers),
    ).map((member) => namedIri(member, "owl:members entry"))

    for (const [index, first] of members.entries()) {
      for (const second of members.slice(index + 1)) {
        addDisjointPair(first, second)
      }
    }
  }

  for (const quad of store.getQuads(null, rdfsSubClassOf, null, null)) {
    if (quad.subject.termType === "NamedNode") {
      classes.add(quad.subject.value)
    }
    if (quad.object.termType === "NamedNode") {
      classes.add(quad.object.value)
    }
  }

  for (const declaredClass of store.getSubjects(rdfType, owlClass, null)) {
    classes.add(namedIri(declaredClass, "owl:Class subject"))
  }

  const firstDisjointPair = (classIris: Iterable<string>) => {
    const expandedClasses = [...classIris].sort()
    for (const [index, first] of expandedClasses.entries()) {
      for (const second of expandedClasses.slice(index + 1)) {
        if (disjointPairs.has(pairKey(first, second))) {
          return [first, second] as const
        }
      }
    }

    return undefined
  }

  const violations: DisjointnessViolation[] = []

  for (const classIri of [...classes].sort()) {
    const disjointClasses = firstDisjointPair(
      superclassClosure(store, classIri),
    )
    if (disjointClasses !== undefined) {
      violations.push({
        kind: "class",
        subject: classIri,
        disjointClasses,
      })
    }
  }

  const individuals = new Map<string, Set<string>>()
  for (const quad of store.getQuads(null, rdfType, null, null)) {
    const types = individuals.get(quad.subject.value) ?? new Set<string>()
    types.add(namedIri(quad.object, "rdf:type object"))
    individuals.set(quad.subject.value, types)
  }

  for (const [individual, directTypes] of [...individuals].sort()) {
    const inferredTypes = new Set<string>()
    for (const directType of directTypes) {
      for (const inferredType of superclassClosure(store, directType)) {
        inferredTypes.add(inferredType)
      }
    }

    const disjointClasses = firstDisjointPair(inferredTypes)
    if (disjointClasses !== undefined) {
      violations.push({
        kind: "individual",
        subject: individual,
        disjointClasses,
      })
    }
  }

  return violations
}

const expectLifecycleTerm = (
  store: Store,
  localName: string,
  notation: string,
  label: string,
  parent: Term,
) => {
  const subject = term(localName)

  expect(store.countQuads(subject, rdfType, owlClass, null)).toBe(1)
  expect(store.countQuads(subject, rdfType, skosConcept, null)).toBe(1)
  expect(store.countQuads(subject, rdfType, parent, null)).toBe(1)
  expect(store.countQuads(subject, rdfsSubClassOf, parent, null)).toBe(1)

  const actualNotation = getOnlyLiteral(store, subject, skosNotation)
  expect(actualNotation.value).toBe(notation)

  const actualLabel = getOnlyLiteral(store, subject, skosPrefLabel)
  expect(actualLabel.value).toBe(label)
  expect(actualLabel.language).toBe("en")

  const definition = getOnlyLiteral(store, subject, skosDefinition)
  expect(definition.language).toBe("en")
  expect(definition.value.length).toBeGreaterThan(20)
}

const getContextTerm = (label: string) => {
  const labelLiteral = DataFactory.literal(label, "en")
  const subjects = ontology
    .getSubjects(skosPrefLabel, labelLiteral, null)
    .filter(
      (subject) =>
        ontology.countQuads(subject, rdfType, contextTermClass, null) === 1,
    )

  expect(subjects).toHaveLength(1)
  const subject = subjects[0]
  if (subject === undefined) {
    throw new Error(`Missing ontology counterpart for CONTEXT.md term ${label}`)
  }

  return subject
}

const expectDisjoint = (first: Term, second: Term) => {
  expect(
    ontology.countQuads(first, owlDisjointWith, second, null) +
      ontology.countQuads(second, owlDisjointWith, first, null),
  ).toBeGreaterThan(0)
}

const expectSomeValuesFrom = (
  subject: Term,
  property: Term,
  expectedClass: Term,
) => {
  const restrictions = ontology
    .getObjects(subject, rdfsSubClassOf, null)
    .filter(
      (candidate) =>
        ontology.countQuads(candidate, rdfType, owlRestriction, null) === 1 &&
        ontology.countQuads(candidate, owlOnProperty, property, null) === 1 &&
        ontology.countQuads(
          candidate,
          owlSomeValuesFrom,
          expectedClass,
          null,
        ) === 1,
    )

  expect(restrictions).toHaveLength(1)
}

describe("CONTEXT.md vocabulary parity", () => {
  it("declares exactly one ontology context term for every glossary heading", () => {
    const expectedLabels = contextTerms.map(({ label }) => label).sort()
    const actualContextTerms = ontology.getSubjects(
      rdfType,
      contextTermClass,
      null,
    )
    const actualLabels = actualContextTerms
      .map((subject) => getOnlyLiteral(ontology, subject, skosPrefLabel).value)
      .sort()

    expect(actualLabels).toEqual(expectedLabels)
    expect(new Set(actualLabels).size).toBe(actualLabels.length)
  })

  it("keeps every SKOS preferred label in exact parity with glossary headings", () => {
    const expectedLabels = contextTerms.map(({ label }) => label).sort()
    const actualLabels = ontology
      .getObjects(null, skosPrefLabel, null)
      .map(({ value }) => value)
      .sort()

    expect(actualLabels).toEqual(expectedLabels)
  })

  for (const contextEntry of contextTerms) {
    it(`${contextEntry.label} preserves its definition and avoided labels`, () => {
      const subject = getContextTerm(contextEntry.label)
      expect(ontology.countQuads(subject, rdfType, skosConcept, null)).toBe(1)

      const ontologyKinds = [
        owlClass,
        owlObjectProperty,
        owlDatatypeProperty,
        owlNamedIndividual,
      ].filter(
        (kind) => ontology.countQuads(subject, rdfType, kind, null) === 1,
      )
      expect(ontologyKinds.length).toBeGreaterThan(0)

      const definition = getOnlyLiteral(ontology, subject, skosDefinition)
      expect(definition.value).toBe(contextEntry.definition)
      expect(definition.language).toBe("en")

      const actualHiddenLabels = ontology
        .getObjects(subject, skosHiddenLabel, null)
        .map(({ value }) => value)
        .sort()
      expect(actualHiddenLabels).toEqual(
        contextEntry.avoidedLabels.map(({ label }) => label).sort(),
      )

      for (const avoidedLabel of contextEntry.avoidedLabels) {
        const labelLiteral = DataFactory.literal(avoidedLabel.label, "en")
        const annotations = ontology
          .getSubjects(owlAnnotatedSource, subject, null)
          .filter(
            (annotation) =>
              ontology.countQuads(annotation, rdfType, owlAxiom, null) === 1 &&
              ontology.countQuads(
                annotation,
                owlAnnotatedProperty,
                skosHiddenLabel,
                null,
              ) === 1 &&
              ontology.countQuads(
                annotation,
                owlAnnotatedTarget,
                labelLiteral,
                null,
              ) === 1,
          )
        expect(annotations).toHaveLength(1)

        const rationale = getOnlyLiteral(
          ontology,
          annotations[0]!,
          avoidanceRationale,
        )
        expect(rationale.language).toBe("en")
        if (avoidedLabel.rationale !== undefined) {
          expect(rationale.value).toBe(avoidedLabel.rationale)
        } else {
          expect(rationale.value.length).toBeGreaterThan(10)
        }
      }
    })
  }
})

describe("full vocabulary semantic distinctions", () => {
  it("defines each shared predicate as exactly one class expression", () => {
    for (const localName of [
      "LeafIssue",
      "ImplementableIssue",
      "ActionableIssue",
      "RelevantIssue",
      "UnfinishedWorkItem",
    ]) {
      expect(
        ontology.countQuads(term(localName), owlEquivalentClass, null, null),
      ).toBe(1)
    }
  })

  it("keeps Repository Paused distinct from Pause Work Item", () => {
    expectDisjoint(term("Paused"), term("PauseWorkItem"))
  })

  it("keeps Waiting for blockers distinct from Admitted Work Item", () => {
    expectDisjoint(term("WaitingForBlockers"), term("AdmittedWorkItem"))
  })

  it("keeps Auto-merge distinct from Merge Mode always", () => {
    expect(
      ontology.countQuads(
        term("MergeModeAlways"),
        rdfsSubClassOf,
        term("MergeMode"),
        null,
      ),
    ).toBe(1)
    expectDisjoint(term("AutoMerge"), term("MergeModeAlways"))
  })

  it("declares the terminal states pairwise disjoint", () => {
    const expectedTerminalIris = Object.keys(expectedTerminalTerms).map(
      (localName) => `${namespace.rfa}${localName}`,
    )
    const hasExactTerminalAxiom = ontology
      .getSubjects(rdfType, owlAllDisjointClasses, null)
      .some((axiom) => {
        const members = getOnlyObject(ontology, axiom, owlMembers)
        const actual = readRdfList(ontology, members)
          .map(({ value }) => value)
          .sort()
        return (
          JSON.stringify(actual) ===
          JSON.stringify([...expectedTerminalIris].sort())
        )
      })

    expect(hasExactTerminalAxiom).toBe(true)
  })

  it("aligns execution concepts with PROV-O", () => {
    expect(
      ontology.countQuads(
        term("StepRun"),
        rdfsSubClassOf,
        iri(`${namespace.prov}Activity`),
        null,
      ),
    ).toBe(1)
    expect(
      ontology.countQuads(
        term("AgentTurn"),
        rdfsSubClassOf,
        iri(`${namespace.prov}Activity`),
        null,
      ),
    ).toBe(1)
    expect(
      ontology.countQuads(
        term("AgentBackend"),
        rdfsSubClassOf,
        iri(`${namespace.prov}SoftwareAgent`),
        null,
      ),
    ).toBe(1)
    expect(
      ontology.countQuads(
        term("Operator"),
        rdfsSubClassOf,
        iri(`${namespace.prov}Person`),
        null,
      ),
    ).toBe(1)
  })

  it("attributes outcomes to an Agent Backend or the Harness", () => {
    expect(
      ontology.countQuads(
        term("Outcome"),
        rdfsSubClassOf,
        iri(`${namespace.prov}Entity`),
        null,
      ),
    ).toBe(1)
    expectSomeValuesFrom(
      term("AgentAttributedOutcome"),
      iri(`${namespace.prov}wasAttributedTo`),
      term("AgentBackend"),
    )
    expectSomeValuesFrom(
      term("HarnessAttributedOutcome"),
      iri(`${namespace.prov}wasAttributedTo`),
      term("Harness"),
    )
    expect(
      ontology.countQuads(
        term("AgentReportedOutcome"),
        rdfsSubClassOf,
        term("AgentAttributedOutcome"),
        null,
      ),
    ).toBe(1)
  })
})

describe("rfa lifecycle ontology", () => {
  it("declares exactly the operational Lifecycle Steps from CONTEXT.md", () => {
    const actualTerms = ontology.getSubjects(rdfType, operationalClass, null)
    const expectedIris = Object.keys(expectedOperationalTerms).map(
      (localName) => `${namespace.rfa}${localName}`,
    )
    expectExactIris(actualTerms, expectedIris)

    for (const [localName, [notation, label]] of Object.entries(
      expectedOperationalTerms,
    )) {
      expectLifecycleTerm(
        ontology,
        localName,
        notation,
        label,
        operationalClass,
      )
    }
  })

  it("declares exactly the terminal Work Item states from CONTEXT.md", () => {
    const actualTerms = ontology.getSubjects(rdfType, terminalClass, null)
    const expectedIris = Object.keys(expectedTerminalTerms).map(
      (localName) => `${namespace.rfa}${localName}`,
    )
    expectExactIris(actualTerms, expectedIris)

    for (const [localName, [notation, label]] of Object.entries(
      expectedTerminalTerms,
    )) {
      expectLifecycleTerm(ontology, localName, notation, label, terminalClass)
    }
  })

  it("keeps the operational and terminal state classes disjoint", () => {
    expect(
      ontology.countQuads(
        operationalClass,
        owlDisjointWith,
        terminalClass,
        null,
      ),
    ).toBe(1)

    const hasStateSpaceAxiom = ontology
      .getSubjects(rdfType, owlAllDisjointClasses, null)
      .some((axiom) => {
        const members = getOnlyObject(ontology, axiom, owlMembers)
        const actual = readRdfList(ontology, members)
          .map(({ value }) => value)
          .sort()
        return (
          JSON.stringify(actual) ===
          JSON.stringify([...expectedStateIris].sort())
        )
      })
    expect(hasStateSpaceAxiom).toBe(true)
  })

  it("has no disjoint class contradictions", () => {
    expect(findDisjointnessViolations(ontology)).toEqual([])
  })

  it("detects an axiom that makes a lifecycle class contradictory", () => {
    const inconsistentOntology = new Store(
      ontology.getQuads(null, null, null, null),
    )
    inconsistentOntology.addQuad(
      term("Implement"),
      rdfsSubClassOf,
      term("Complete"),
    )

    expect(
      findDisjointnessViolations(inconsistentOntology).some(
        ({ kind, subject }) =>
          kind === "class" && subject === term("Implement").value,
      ),
    ).toBe(true)
  })

  it("keeps the Work Item shape in parity with the declared state space", () => {
    const currentStateProperties = shapes.getSubjects(
      shPath,
      term("currentState"),
      null,
    )
    expect(currentStateProperties).toHaveLength(1)

    const allowedStates = getOnlyObject(
      shapes,
      currentStateProperties[0]!,
      shIn,
    )
    expectExactIris(readRdfList(shapes, allowedStates), expectedStateIris)
  })

  it("conforms to its own lifecycle vocabulary shapes", async () => {
    const report = await new SHACLValidator(shapes).validate(ontology)
    expect(report.conforms).toBe(true)
    expect(report.results).toHaveLength(0)
  })

  it.each([
    ["year-month duration", "P1M", xsdDuration],
    ["zero duration", "PT0S", xsdDayTimeDuration],
    ["sub-millisecond duration", "PT0.0001S", xsdDayTimeDuration],
  ])("rejects an unsupported %s", async (_, value, datatype) => {
    const unsupportedOntology = new Store(
      ontology.getQuads(null, null, null, null),
    )
    unsupportedOntology.removeMatches(
      term("Implement"),
      maximumDuration,
      null,
      null,
    )
    unsupportedOntology.addQuad(
      term("Implement"),
      maximumDuration,
      DataFactory.literal(value, datatype),
    )

    const report = await new SHACLValidator(shapes).validate(
      unsupportedOntology,
    )
    expect(report.conforms).toBe(false)
  })
})

interface Fixture {
  readonly file: string
  readonly category: "valid" | "invalid" | "missing-fact" | "contradictory"
  readonly conforms: boolean
  readonly consistent: boolean
}

interface FixtureManifest {
  readonly fixtures: readonly Fixture[]
}

const fixtureManifest = JSON.parse(
  readFileSync(resolve(fixturesRoot, "manifest.json"), "utf8"),
) as FixtureManifest

const expectedFixtureVerdicts = {
  valid: { conforms: true, consistent: true },
  invalid: { conforms: false, consistent: true },
  "missing-fact": { conforms: false, consistent: true },
  contradictory: { conforms: false, consistent: false },
} as const

describe("SHACL and consistency fixture corpus", () => {
  it("asserts at least one fixture and verdict for every required category", () => {
    const actualCategories = [
      ...new Set(fixtureManifest.fixtures.map(({ category }) => category)),
    ].sort()
    expect(actualCategories).toEqual(
      Object.keys(expectedFixtureVerdicts).sort(),
    )

    for (const fixture of fixtureManifest.fixtures) {
      expect({
        conforms: fixture.conforms,
        consistent: fixture.consistent,
      }).toEqual(expectedFixtureVerdicts[fixture.category])
    }

    const declaredFiles = fixtureManifest.fixtures
      .map(({ file }) => file)
      .sort()
    const corpusFiles = readdirSync(fixturesRoot)
      .filter((file) => file.endsWith(".ttl"))
      .sort()
    expect(declaredFiles).toEqual(corpusFiles)
    expect(declaredFiles).toContain("valid-execution.ttl")
  })

  it("rejects fixtures that cross each prose-fought distinction", () => {
    const data = parseTurtle(resolve(fixturesRoot, "contradictory.ttl"))
    const dataAndOntology = new Store([
      ...ontology.getQuads(null, null, null, null),
      ...data.getQuads(null, null, null, null),
    ])
    const contradictorySubjects = findDisjointnessViolations(dataAndOntology)
      .filter(({ kind }) => kind === "individual")
      .map(({ subject }) => subject)

    expect(contradictorySubjects).toContain(
      "https://ready-for-agent.dev/ontology/examples#waiting-and-admitted",
    )
    expect(contradictorySubjects).toContain(
      "https://ready-for-agent.dev/ontology/examples#paused-repository-action",
    )
    expect(contradictorySubjects).toContain(
      "https://ready-for-agent.dev/ontology/examples#auto-merge-mode-always",
    )
    expect(contradictorySubjects).toContain(
      "https://ready-for-agent.dev/ontology/examples#two-terminal-states",
    )
  })

  for (const fixture of fixtureManifest.fixtures) {
    it(`${fixture.file} has its asserted ${fixture.category} verdict`, async () => {
      const data = parseTurtle(resolve(fixturesRoot, fixture.file))
      const report = await new SHACLValidator(shapes).validate(data)
      expect(report.conforms).toBe(fixture.conforms)

      const dataAndOntology = new Store([
        ...ontology.getQuads(null, null, null, null),
        ...data.getQuads(null, null, null, null),
      ])
      expect(findDisjointnessViolations(dataAndOntology).length === 0).toBe(
        fixture.consistent,
      )
    })
  }
})
