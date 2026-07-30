import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import type { Term } from "n3"
import { DataFactory, Parser, Store } from "n3"
import SHACLValidator from "rdf-validate-shacl"
import { describe, expect, it } from "bun:test"

const ontologyRoot = resolve(import.meta.dir, "../../../ontology")
const fixturesRoot = resolve(ontologyRoot, "fixtures")

const namespace = {
  owl: "http://www.w3.org/2002/07/owl#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  rfa: "https://ready-for-agent.dev/ontology/rfa#",
  sh: "http://www.w3.org/ns/shacl#",
  skos: "http://www.w3.org/2004/02/skos/core#",
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
const owlDisjointWith = iri(`${namespace.owl}disjointWith`)
const owlMembers = iri(`${namespace.owl}members`)
const skosConcept = iri(`${namespace.skos}Concept`)
const skosDefinition = iri(`${namespace.skos}definition`)
const skosNotation = iri(`${namespace.skos}notation`)
const skosPrefLabel = iri(`${namespace.skos}prefLabel`)
const shIn = iri(`${namespace.sh}in`)
const shPath = iri(`${namespace.sh}path`)

const operationalClass = term("OperationalLifecycleStep")
const terminalClass = term("TerminalWorkItemState")

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

const ontology = parseTurtle(resolve(ontologyRoot, "rfa.ttl"))
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
      const parentIri = namedIri(parent, "rdfs:subClassOf object")
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
    classes.add(namedIri(quad.subject, "rdfs:subClassOf subject"))
    classes.add(namedIri(quad.object, "rdfs:subClassOf object"))
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

    const disjointAxioms = ontology.getSubjects(
      rdfType,
      owlAllDisjointClasses,
      null,
    )
    expect(disjointAxioms).toHaveLength(1)

    const members = getOnlyObject(ontology, disjointAxioms[0]!, owlMembers)
    expectExactIris(readRdfList(ontology, members), expectedStateIris)
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
  it("asserts one fixture and verdict for every required category", () => {
    const actualCategories = fixtureManifest.fixtures
      .map(({ category }) => category)
      .sort()
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
  })

  for (const fixture of fixtureManifest.fixtures) {
    it(`${fixture.category} graph has its asserted verdict`, async () => {
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
