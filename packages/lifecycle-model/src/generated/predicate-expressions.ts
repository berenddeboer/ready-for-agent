// This file is generated from the predicate class expressions in ontology/rfa.ttl.
// Run `bunx nx run lifecycle-model:generate` to update it.

export type LifecyclePredicateName =
  | "LeafIssue"
  | "ImplementableIssue"
  | "ActionableIssue"
  | "RelevantIssue"
  | "UnfinishedWorkItem"

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
> = {
  "LeafIssue": {
    "kind": "intersection",
    "expressions": [
      {
        "kind": "class",
        "name": "Issue"
      },
      {
        "kind": "hasValue",
        "property": "hasChildren",
        "value": false
      }
    ]
  },
  "ImplementableIssue": {
    "kind": "intersection",
    "expressions": [
      {
        "kind": "class",
        "name": "LeafIssue"
      },
      {
        "kind": "hasValue",
        "property": "isCurrentIssue",
        "value": true
      },
      {
        "kind": "hasValue",
        "property": "isOpenIssue",
        "value": true
      },
      {
        "kind": "hasValue",
        "property": "listedBlockerCount",
        "value": 0
      }
    ]
  },
  "ActionableIssue": {
    "kind": "intersection",
    "expressions": [
      {
        "kind": "class",
        "name": "ImplementableIssue"
      },
      {
        "kind": "hasValue",
        "property": "unfinishedWorkItemCount",
        "value": 0
      }
    ]
  },
  "RelevantIssue": {
    "kind": "intersection",
    "expressions": [
      {
        "kind": "class",
        "name": "ReadyLabeledIssue"
      },
      {
        "kind": "hasValue",
        "property": "isInSupportedIssueHierarchy",
        "value": true
      },
      {
        "kind": "hasValue",
        "property": "satisfiesClosingPullRequestCondition",
        "value": true
      },
      {
        "kind": "hasValue",
        "property": "isIssueAuthorIncluded",
        "value": true
      }
    ]
  },
  "UnfinishedWorkItem": {
    "kind": "intersection",
    "expressions": [
      {
        "kind": "class",
        "name": "WorkItem"
      },
      {
        "kind": "union",
        "expressions": [
          {
            "kind": "someValueOutside",
            "property": "currentState",
            "excludedValues": [
              "complete",
              "failed",
              "abandoned"
            ]
          },
          {
            "kind": "hasValue",
            "property": "canRetry",
            "value": true
          }
        ]
      }
    ]
  }
}

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
        throw new Error(`Cyclic lifecycle predicate: ${expression.name}`)
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
