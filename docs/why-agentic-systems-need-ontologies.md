# Why Agentic Systems Need Ontologies

**Frank Coyle**

*Adapted from the
[original talk](https://www.youtube.com/watch?v=Sir59K8ZDPU) and expanded with
technical clarifications and implementation examples.*

"Nothing is a mistake. There's no win and no fail. There's only make" is a
useful philosophy for learning. It is a dangerous execution policy for an AI
agent connected to refunds, payouts, customer records, or production systems.

Consider three proposed actions:

- A second refund on the same order
- A payout sent to a support representative instead of the buyer
- An order status changed to `probably shipped`

All three can be expressed as fluent English. All three can arrive as valid
JSON. None should be allowed to change the system of record.

Prompt instructions alone are not a reliable enforcement mechanism. Large
language models are probabilistic by design. That probabilistic behavior is
also the source of their flexibility: they can interpret ambiguous requests,
connect ideas, and produce candidates that were not explicitly programmed.
The goal is therefore not to make the model deterministic. The goal is to
place deterministic boundaries around what its proposals are allowed to do.

This is the case for a neurosymbolic architecture: probabilistic reasoning on
the inside, formal meaning and enforceable policy on the outside.

## Two Traditions Converge

The idea of an agent reaches back to the earliest years of artificial
intelligence. Work by John McCarthy, Oliver Selfridge, Marvin Minsky, and
others established a model of a system that perceives, decides, and acts. The
term "artificial intelligence" appeared in the 1955 proposal for the 1956
Dartmouth workshop, but the questions raised there remain familiar: how can a
machine represent a world, choose an action, and pursue a goal?

Ontology has a much older lineage. Aristotle's categories asked what kinds of
things exist and how they can be described. W. V. O. Quine connected ontology
to the commitments made by a theory. In knowledge engineering, Thomas Gruber
defined an ontology as "an explicit specification of a conceptualization."
The later and widely used formulation is "a formal, explicit specification of
a shared conceptualization."

Those lineages now meet in agentic systems. An LLM can propose an action, but
it does not inherently share an organization's exact definitions of an order,
a buyer, a refund, an authorized recipient, or a legal state transition. An
ontology makes that domain model explicit and machine-readable.

Earlier symbolic AI and expert systems attempted to encode intelligence in
rules. They were often difficult to scale because acquiring and maintaining
the knowledge became a bottleneck. Neural networks took the opposite path,
learning statistical patterns from data, and became practical at modern scale
with sufficient data and compute. Neurosymbolic systems combine the strengths
of both approaches rather than treating either as sufficient by itself.

## What an Ontology Contributes

An ontology describes the entities in a domain, the relationships between
them, their properties, and the axioms that give those terms meaning. A simple
commerce ontology might include:

- Entities such as `Order`, `Customer`, `SupportRepresentative`, `Payment`,
  and `Refund`
- Relationships such as `placedBy`, `hasRefund`, `payoutRecipient`, and
  `hasStatus`
- Class relationships such as every `Customer` being a `Person`
- Incompatibilities such as `Customer` and `SupportRepresentative` being
  disjoint roles in a particular workflow
- State rules such as the allowed order statuses or number of refunds

Ontologies are commonly represented as graphs because relationships are
first-class elements of the model. A graph can be extended by adding another
node, property, or relationship without forcing every entity into the same
table shape. This does not mean relational databases cannot evolve, or that an
ontology requires a graph database. The semantic model and its storage engine
are separate design decisions.

Domain models can be built in two complementary directions. A top-down process
brings domain experts together to identify concepts, relationships, and
invariants. A bottom-up process examines actual events, documents, customer
interactions, and operational failures to discover concepts the first model
missed.

Existing vocabularies reduce reinvention:

- [Schema.org](https://schema.org/) provides terms for common web entities and
  relationships.
- [FOAF](https://xmlns.com/foaf/spec/) models people and social relationships.
- [Dublin Core](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
  provides metadata terms for documents and other resources.
- [DBpedia](https://www.dbpedia.org/about/) extracts structured knowledge from
  Wikipedia and other Wikimedia projects.

These vocabularies are starting points, not substitutes for a domain model.
Reusing a term does not automatically teach an agent an organization's
policies, and DBpedia is downstream of Wikipedia rather than the foundation of
Wikipedia search.

## RDFS Adds Inferable Meaning

[RDF Schema](https://www.w3.org/TR/rdf-schema/) provides basic vocabulary for
classes, subclasses, property domains, and property ranges. The following
graph defines the meaning of `teaches`:

```turtle
@prefix ex: <https://example.com/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

ex:teaches
  rdfs:domain ex:Teacher ;
  rdfs:range ex:Student .

ex:Teacher rdfs:subClassOf ex:Person .

ex:Bob ex:teaches ex:Scooter .
```

An RDFS reasoner can derive three facts that were not stated directly:

```turtle
ex:Bob a ex:Teacher .
ex:Bob a ex:Person .
ex:Scooter a ex:Student .
```

This is inference, not record validation. Domain and range declarations do not
normally reject a triple whose subject or object lacks the expected type. They
infer that type. For example, if `hasAge` has domain `Person` and Felix has an
age, an RDFS reasoner infers that Felix is a person even if Felix was already
described as a cat. A contradiction appears only if additional axioms make
`Cat` and `Person` incompatible.

That distinction matters when RDFS is used as an agent guardrail. It can
enrich the proposed state and expose consequences. It does not by itself act
like a closed-world input schema.

## OWL Adds Richer Inference and Consistency Checks

The [Web Ontology Language](https://www.w3.org/TR/owl2-primer/) adds more
expressive relationships and class descriptions.

A transitive property allows a reasoner to derive a relationship across a
chain:

```turtle
@prefix ex: <https://example.com/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

ex:ancestorOf a owl:TransitiveProperty .

ex:Sue ex:ancestorOf ex:Mary .
ex:Mary ex:ancestorOf ex:Anne .
```

The reasoner can infer:

```turtle
ex:Sue ex:ancestorOf ex:Anne .
```

A functional property says that each subject has at most one semantic value:

```turtle
ex:hasFather a owl:FunctionalProperty .

ex:Jim ex:hasFather ex:Bob .
ex:Jim ex:hasFather ex:BB .
```

This does not automatically report two fathers as a validation error. OWL does
not assume that different names identify different individuals, so the
reasoner can infer that `ex:Bob` and `ex:BB` refer to the same individual. The
ontology becomes inconsistent only if they are also known to be different.

OWL can also express disjoint classes:

```turtle
ex:Customer owl:disjointWith ex:SupportRepresentative .
```

If the same individual is inferred or asserted to belong to both classes, the
ontology is inconsistent. This can contribute to checking a payout recipient,
but disjointness alone is not enough. The system must also know the recipient's
role and what role or exact individual the payout requires.

OWL follows an open-world assumption. Missing information is unknown, not
false, and different identifiers may name the same thing. This makes OWL
powerful for integrating incomplete knowledge, but it means OWL is not a
drop-in replacement for database constraints or request validation. An
application must run a reasoner and explicitly decide that an inconsistency
blocks the action.

## Validation Is Different From Reasoning

Reasoning asks what follows from a set of facts and whether those facts can be
true together. Validation asks whether the data currently present satisfies a
prescriptive contract. Both are needed.

[SHACL](https://www.w3.org/TR/shacl/) is a W3C standard designed to validate
RDF graphs. The following shapes express closed-world contracts for orders and
proposed payouts:

```turtle
@prefix ex: <https://example.com/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .

ex:OrderShape
  a sh:NodeShape ;
  sh:targetClass ex:Order ;
  sh:property [
    sh:path ex:status ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:in ("paid" "shipped" "refunded") ;
  ] ;
  sh:property [
    sh:path ex:refund ;
    sh:maxCount 1 ;
  ] ;
  sh:property [
    sh:path ex:buyer ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:class ex:Customer ;
  ] .

ex:PayoutProposalShape
  a sh:NodeShape ;
  sh:targetClass ex:PayoutProposal ;
  sh:property [
    sh:path ex:buyer ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:class ex:Customer ;
  ] ;
  sh:property [
    sh:path ex:recipient ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:class ex:Customer ;
    sh:equals ex:buyer ;
  ] .
```

These shapes give precise results:

- `probably shipped` fails because it is not in the allowed status list.
- A second `refund` value fails `sh:maxCount 1`.
- A payout to a support representative fails because the recipient must be a
  customer and must equal the proposal's authoritative buyer.

Requiring equality with the buyer is stronger than merely declaring customer
and support roles disjoint. Otherwise, a payout to the wrong customer could
still pass the role check. The controller must copy the buyer onto the payout
proposal from the current order record; it must not trust the model to supply
both `buyer` and `recipient`, or the model could make an incorrect pair appear
self-consistent.

SHACL and OWL are complementary. OWL states what facts mean and what can be
inferred. SHACL states what an acceptable data graph must contain. Neither
replaces authorization policy: a logically consistent and structurally valid
action may still be forbidden for the current user or agent.

## Pydantic at the Door

Tool arguments should be checked before they enter the semantic layer.
[Pydantic](https://docs.pydantic.dev/latest/) can validate the structure and
types of a Python-facing request:

```python
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RefundProposal(BaseModel):
    model_config = ConfigDict(strict=True)

    order_id: str
    amount_cents: int = Field(gt=0)
    next_status: Literal["refunded"]
```

This model rejects missing fields, a non-integer `amount_cents`, a non-positive
amount, or an invented next status. Strict mode is explicit because Pydantic
normally coerces compatible values where possible. Python is dynamically
typed, but Pydantic uses its type hints for runtime validation.

Pydantic cannot determine from this model whether the order has already been
refunded, whether the amount exceeds the refundable balance, or whether the
caller is authorized. Those checks require current domain state and policy.
The useful division is:

> Pydantic at the door, ontology and policy at the ledger.

## Agent Loops Need Boundaries

Sequence, selection, and iteration are the basic structures associated with
the Bohm-Jacopini structured-program theorem. Iteration is also what turns a
single model response into an agent loop: inspect the situation, propose a
tool call, observe the result, and continue.

The theorem does not establish that adding a loop automatically makes every
agent Turing complete. Computational power also depends on the operations and
memory available. The practical point is simpler: a loop gives an agent the
ability to continue acting, which also gives failures time to compound.

Agent loops can:

- Run indefinitely
- Drift as model outputs become later inputs
- Amplify errors across multiple agents
- Consume unbounded tokens, time, or money
- Repeat non-idempotent side effects

An LLM does not execute a client tool by itself. It emits a structured tool-use
request, and the surrounding controller decides whether and how to execute it.
That controller is the enforcement boundary. Treat a tool call as a proposal,
not as authority.

A safe loop follows this order:

1. The model proposes a tool call and arguments.
2. Pydantic or JSON Schema validates the request structure.
3. Read-only tools gather the current state needed for the decision.
4. The controller constructs a candidate state transition or candidate graph.
5. RDFS or OWL reasoning makes implicit consequences explicit and checks
   consistency.
6. SHACL, business rules, and authorization policy validate the candidate
   against the current ledger.
7. A transaction commits the change only if every gate succeeds.
8. A rejected proposal returns structured feedback to the model or escalates
   to a human.

The ordering is essential. A mutating refund tool must not issue the refund and
only then ask the ontology whether it was valid. Either the tool should produce
a side-effect-free proposal, or the controller should validate its arguments
and candidate transition before invoking the mutation.

## Guardrails by Failure Type

Different failures belong at different layers:

| Proposed failure | First useful gate | Final protection |
| --- | --- | --- |
| Malformed tool arguments | JSON Schema or strict Pydantic | Reject before domain processing |
| Status `probably shipped` | Pydantic `Literal` or SHACL `sh:in` | Database enum or check constraint |
| Second refund | Ledger-aware SHACL or business rule | Atomic transaction, idempotency key, or unique constraint |
| Payout to support representative | Recipient equality, role, and authorization policy | Transactional authorization check |
| Two identifiers for one functional value | OWL functional-property reasoning | Identity-resolution policy |

The final protection matters because validation against a snapshot does not
prevent a race. Two agent workers could both observe that no refund exists,
both pass SHACL, and both attempt to create one. Transaction isolation, an
idempotency key, or a database uniqueness constraint must make the invariant
atomic.

Ontologies therefore complement ordinary software controls. They do not
replace database integrity, authorization, idempotency, budgets, timeouts, or
human approval.

## Building a Maintainable Semantic Layer

A useful ontology does not need to model the entire world. Start with the
smallest domain in which an agent can cause material harm or confusion.

1. Write concrete questions the model must answer, such as "Who may receive
   this payout?" and "Has this order already been refunded?"
2. Identify the entities and relationships needed to answer those questions.
3. Reuse standard vocabulary where its meaning matches the domain.
4. Add organization-specific terms only where the shared vocabulary is
   insufficient.
5. Keep descriptive semantics, validation shapes, authorization rules, and
   storage constraints distinct, even if they are tested together.
6. Test valid examples, invalid examples, missing facts, contradictory facts,
   and concurrent updates.
7. Version the ontology and shapes as production interfaces rather than static
   documentation.

This avoids recreating the expert-system knowledge bottleneck. The semantic
layer should be small enough to understand, test, and evolve while remaining
rich enough to express the decisions that must not be left to prompt prose.

## Conclusion

Ontologies do not make a probabilistic model deterministic. They give the
surrounding system a shared language for deciding what the model's proposals
mean. RDFS and OWL add inference and consistency checking. SHACL and typed
schemas validate concrete data. Authorization and business rules decide what
is permitted. Transactions ensure that an approved action remains valid when
it is committed.

The resulting architecture preserves what LLMs are good at without confusing
suggestion with authority:

```text
probabilistic proposal
-> typed boundary
-> semantic reasoning
-> closed-world validation
-> authorization
-> atomic side effect
```

Use the model to imagine and propose. Use formal, testable, and deliberately
boring software to decide what becomes real.

## References and Further Reading

- [Why Agentic Systems Need Ontologies](https://www.youtube.com/watch?v=Sir59K8ZDPU)
- [Corita Kent's Ten Rules](https://www.corita.org/tenrules)
- [The Dartmouth Summer Research Project proposal](https://www-formal.stanford.edu/jmc/history/dartmouth/dartmouth.html)
- [Marvin Minsky, Society of Mind](https://www.simonandschuster.com/books/Society-Of-Mind/Marvin-Minsky/9780671657130)
- [Aristotle's Categories](https://plato.stanford.edu/entries/aristotle-categories/)
- [W. V. O. Quine](https://plato.stanford.edu/entries/quine/)
- [Thomas Gruber, A Translation Approach to Portable Ontology Specifications](https://tomgruber.org/writing/ontolingua-kaj-1993/)
- [Studer, Benjamins, and Fensel, Knowledge Engineering: Principles and Methods](https://doi.org/10.1016/S0169-023X(97)00056-6)
- [Bohm and Jacopini, Flow Diagrams, Turing Machines and Languages with Only Two Formation Rules](https://dl.acm.org/doi/10.1145/355592.365646)
- [RDF Schema 1.1](https://www.w3.org/TR/rdf-schema/)
- [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/)
- [SHACL](https://www.w3.org/TR/shacl/)
- [Pydantic strict mode](https://docs.pydantic.dev/latest/concepts/strict_mode/)
- [Anthropic tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
