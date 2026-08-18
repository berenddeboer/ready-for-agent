# The ontology owns every Step Run reason code

The ontology already declared the reason codes that appear on lifecycle transitions, plus a few later operational additions, while the harness persisted a larger hand-written `STEP_RUN_REASON` table. The two lists drifted, and the docs implied the ontology owned reason codes when it did not. The ontology now owns the complete vocabulary — transition reasons and operational mid-run reasons — and `STEP_RUN_REASON` is generated from `rfa:StepRunReason` the same way the state space is generated. `check-generated` fails if the checked-in table and `ontology/rfa.ttl` diverge.

**Considered Options.** Restricting the ontology to transition reasons only would have required moving `github_throttled` and the other operational individuals back out and documenting a split that every new code would have to re-learn. Generating the table from the complete ontology is the smaller rule: one place to add a reason, one check that it cannot drift.

**Consequences.** Adding or renaming a reason starts in `ontology/rfa.ttl` (`skos:notation` plus `skos:definition`) and flows through `lifecycle-model:generate`. Do not edit `packages/lifecycle-model/src/generated/work-item-state.ts` or restore a hand-written table in `work-item-lifecycle`.
