---
name: ontology-change
description: Change the Ready for Agent domain model — lifecycle states, transitions, guards, every Step Run reason code (transition and operational), or CONTEXT.md glossary terms. Use whenever a task adds, renames, or removes a Work Item state, transition, or Step Run reason, touches ontology/*.ttl, edits the CONTEXT.md glossary, or fails the lifecycle-model parity or check-generated targets. The ontology owns the complete reason vocabulary; TypeScript, GraphQL, and DB enums are generated from it.
---

# Changing the domain ontology

The domain model lives in `ontology/` as RDF (Turtle) and is the single
source of truth per ADR-0044
(`docs/adr/0044-ontology-derived-lifecycle-model.md`) and ADR-0058
(`docs/adr/0058-ontology-owns-step-run-reason-codes.md`).
Read `ontology/README.md` for the full model and diagrams before editing.

**Never hand-edit generated artifacts.** These are derived and CI-checked:

- `packages/lifecycle-model/src/generated/work-item-state.ts`
  (state space, transition relation, and the complete `STEP_RUN_REASON` table)
- `packages/graphql-schema/src/type-defs.gen.ts`
- Any state enum in `db-schema` or SDL that lists Work Item states — they
  import from `@ready-for-agent/lifecycle-model`.

## Procedure

1. **Edit the ontology first.**
   - New lifecycle state: declare it in `ontology/rfa.ttl` as
     `owl:Class, owl:NamedIndividual, skos:Concept` plus
     `rfa:OperationalLifecycleStep` (or `rfa:TerminalWorkItemState`), with
     `rdfs:subClassOf` the same class, one `skos:notation` (the runtime
     snake_case string), one `skos:prefLabel`, and one `skos:definition`.
     Add it to the `owl:AllDisjointClasses` list of the twenty lifecycle
     values, and to the `sh:in` state list in `ontology/shapes.ttl`
     (`rfa:WorkItemShape`).
   - New transition: declare an `rfa:Transition` individual in `rfa.ttl`
     with exactly one `rfa:fromStep`, `rfa:toStep`, `rfa:guard` (non-empty
     string), and `rfa:reasonCode` (an `rfa:StepRunReason`).
   - New Step Run reason (transition or operational): declare an
     `rfa:StepRunReason` individual in `rfa.ttl` with one `skos:notation`
     (the runtime snake_case or kebab-case string) and one English
     `skos:definition`. `STEP_RUN_REASON` is generated from these
     individuals.
2. **Keep the glossary in parity.** If the term is (or becomes) a CONTEXT.md
   glossary entry, update the glossary in `CONTEXT.md` and mirror it in
   `ontology/context.ttl` (`rfa:ContextTerm` with matching
   `skos:prefLabel`/`skos:definition`; each `_Avoid_:` entry a
   `skos:hiddenLabel` with an `rfa:avoidanceRationale` annotation axiom).
   The parity test fails on any drift, in either direction.
3. **Regenerate.**
   ```sh
   bunx nx run lifecycle-model:generate
   bunx nx run graphql-schema:generate
   ```
4. **Update fixtures if validity changed.** If the change alters what counts
   as valid, missing, or contradictory data, extend the corpus under
   `ontology/fixtures/` and assert each fixture's verdict in
   `ontology/fixtures/manifest.json`.
5. **Verify.**
   ```sh
   bunx nx run lifecycle-model:check-generated
   bunx nx run lifecycle-model:test
   ```
   Then run affected tests for downstream packages (`db-schema`,
   `graphql-schema`, `work-item-lifecycle`) via `bunx nx affected -t test`.

## Runtime enforcement to be aware of

`work-item-lifecycle` checks every applied state change against the generated
transition relation (`checkAppliedLifecycleTransition`): undeclared pairs log
a warning in production and are fatal under test. If a lifecycle test dies
with `UndeclaredLifecycleTransitionError`, the fix is usually to declare the
missing transition in `rfa.ttl` — not to weaken the check.
