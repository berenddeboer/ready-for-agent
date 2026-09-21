import type { ReadyLabeledIssue } from "@ready-for-agent/forge-contract"

export const LINEAR_API_URL = "https://api.linear.app/graphql"
export const LINEAR_API_KEY_ENV_VAR = "LINEAR_API_KEY"
export const LINEAR_VAULT_PROVIDER = "linear"
export const LINEAR_VAULT_ACCOUNT = "api"
export const LINEAR_API_KEY_SECRET_NAME = "LINEAR_API_KEY"
export const LINEAR_API_KEY_CREATION_URL =
  "https://linear.app/settings/account/security"
export const LINEAR_READY_LABEL = "ready-for-agent"

export type LinearReadyLabeledIssue = ReadyLabeledIssue

export interface LinearProject {
  readonly id: string
  readonly name: string
  readonly url: string | null
}

export interface LinearWorkflowState {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly position: number
}

export interface LinearTeamWorkflow {
  readonly teamId: string
  readonly teamKey: string
  readonly teamName: string
  readonly states: readonly LinearWorkflowState[]
  readonly suggestedInProgressStateId: string | null
  readonly suggestedDoneStateId: string | null
}

export const isLinearOpenStateType = (type: string): boolean =>
  type !== "completed" && type !== "canceled"

export const suggestInProgressState = (
  states: readonly LinearWorkflowState[],
): LinearWorkflowState | null => {
  const started = states
    .filter((state) => state.type === "started")
    .sort((left, right) => left.position - right.position)
  return (
    started.find((state) => /in\s*progress/i.test(state.name)) ??
    started[0] ??
    null
  )
}

export const suggestDoneState = (
  states: readonly LinearWorkflowState[],
): LinearWorkflowState | null => {
  const completed = states
    .filter((state) => state.type === "completed")
    .sort((left, right) => left.position - right.position)
  return (
    completed.find((state) => /^done$/i.test(state.name)) ??
    completed[0] ??
    null
  )
}

export const unreadableLinearBlockerUrl = (relationId: string): string =>
  `https://linear.app/#unreadable-${encodeURIComponent(relationId)}`

export const unreadableLinearBlockerNativeId = (relationId: string): string =>
  `unreadable:${relationId}`
