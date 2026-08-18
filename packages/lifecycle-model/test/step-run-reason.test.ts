import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Parser, Store } from "n3"
import {
  LIFECYCLE_TRANSITIONS,
  STEP_RUN_REASON,
  STEP_RUN_REASONS,
  StepRunReason,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const ontologyPath = resolve(import.meta.dir, "../../../ontology/rfa.ttl")

const namespace = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rfa: "https://ready-for-agent.dev/ontology/rfa#",
  skos: "http://www.w3.org/2004/02/skos/core#",
} as const

const rdfType = `${namespace.rdf}type`
const stepRunReasonClass = `${namespace.rfa}StepRunReason`
const skosNotation = `${namespace.skos}notation`

const ontologyReasonNotations = (): readonly string[] => {
  const quads = new Parser({
    baseIRI: `file://${ontologyPath}`,
    format: "Turtle",
  }).parse(readFileSync(ontologyPath, "utf8"))
  const store = new Store(quads)

  return store
    .getSubjects(rdfType, stepRunReasonClass, null)
    .map((subject) => {
      const notations = store.getObjects(subject, skosNotation, null)
      if (notations.length !== 1 || notations[0]?.termType !== "Literal") {
        throw new Error(`${subject.value} must have exactly one skos:notation`)
      }
      return notations[0].value
    })
    .sort()
}

describe("generated STEP_RUN_REASON", () => {
  it("exports exactly the ontology Step Run reason notations", () => {
    expect([...STEP_RUN_REASONS]).toEqual(ontologyReasonNotations())
    expect(Object.values(STEP_RUN_REASON).toSorted()).toEqual(
      ontologyReasonNotations(),
    )
  })

  it("keeps the camelCase accessors used by the harness", () => {
    expect(STEP_RUN_REASON.handlerFailed).toBe("handler_failed")
    expect(STEP_RUN_REASON.handlerDefect).toBe("handler_defect")
    expect(STEP_RUN_REASON.greenNoReviewEvidence).toBe(
      "green-no-review-evidence",
    )
    expect(STEP_RUN_REASON.agentBackendAuthRejected).toBe(
      "agent_backend_auth_rejected",
    )
    expect(STEP_RUN_REASON.waitingForAgentTurn).toBe("waiting_for_agent_turn")
    expect(STEP_RUN_REASON.issueClosedPrClosedUnmerged).toBe(
      "issue_closed_pr_closed_unmerged",
    )
  })

  it("backs the Effect schema with the generated notations", () => {
    expect(StepRunReason.literals).toEqual(STEP_RUN_REASONS)
  })

  it("draws every declared transition reason from the generated table", () => {
    const reasonCodes = new Set<string>(STEP_RUN_REASONS)
    for (const transition of LIFECYCLE_TRANSITIONS) {
      expect(reasonCodes.has(transition.reasonCode)).toBe(true)
    }
  })
})
