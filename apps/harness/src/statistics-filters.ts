import { agentBackendLabel } from "@ready-for-agent/agent-backend"

/** Reserved URL value. Not a catalog model id. */
export const UNKNOWN_MODEL_FILTER = "__unknown__"
const MODEL_VALUE_SEPARATOR = "\u001f"

export const TIMING_AGENT_BACKEND_MAX_LENGTH = 64
export const TIMING_MODEL_MAX_LENGTH = 2048

export function parseStatisticsAgentBackend(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const value = raw.trim()
  if (value.length === 0 || value.length > TIMING_AGENT_BACKEND_MAX_LENGTH) {
    return ""
  }
  return value
}

export function parseStatisticsModel(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const value = raw.trim()
  if (value.length === 0 || value.length > TIMING_MODEL_MAX_LENGTH) return ""
  return value
}

export function timingHistoryQueryKey(input: {
  readonly repositoryId: string
  readonly window: string
  readonly agentBackend: string
  readonly model: string
}): readonly [string, string, string, string, string] {
  return [
    "timingHistory",
    input.repositoryId,
    input.window,
    input.agentBackend,
    input.model,
  ]
}

export function statisticsExplorerKey(input: {
  readonly repository: string
  readonly window: string
  readonly agentBackend: string
  readonly model: string
}): string {
  return [input.repository, input.window, input.agentBackend, input.model].join(
    MODEL_VALUE_SEPARATOR,
  )
}

export type TimingModelChoice = {
  readonly agentBackend: string
  readonly model: string
}

export type StatisticsSelectOption = {
  readonly value: string
  readonly label: string
}

export function modelFilterValue(agentBackend: string, model: string): string {
  return `${agentBackend}${MODEL_VALUE_SEPARATOR}${model}`
}

export function parseModelFilterValue(value: string): {
  readonly agentBackend: string | null
  readonly model: string
} {
  const separator = value.indexOf(MODEL_VALUE_SEPARATOR)
  if (separator < 0) {
    return { agentBackend: null, model: value }
  }
  return {
    agentBackend: value.slice(0, separator),
    model: value.slice(separator + MODEL_VALUE_SEPARATOR.length),
  }
}

export function backendSelectOptions(input: {
  readonly backends: readonly string[]
  readonly selected: string
}): readonly StatisticsSelectOption[] {
  const values = new Set(input.backends)
  if (input.selected !== "") values.add(input.selected)
  return [...values]
    .map((value) => ({ value, label: agentBackendLabel(value) }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.value.localeCompare(right.value),
    )
}

/**
 * Model choices for the selected backend. Identical model ids across backends
 * are separate options. A selection with no matches stays in the list.
 */
export function modelSelectOptions(input: {
  readonly choices: readonly TimingModelChoice[]
  readonly agentBackend: string
  readonly selectedModel: string
}): readonly StatisticsSelectOption[] {
  const scoped =
    input.agentBackend === ""
      ? input.choices
      : input.choices.filter(
          (choice) => choice.agentBackend === input.agentBackend,
        )
  const counts = new Map<string, number>()
  for (const choice of scoped) {
    counts.set(choice.model, (counts.get(choice.model) ?? 0) + 1)
  }
  const options = scoped.map((choice) => {
    const ambiguous = (counts.get(choice.model) ?? 0) > 1
    return {
      value: ambiguous
        ? modelFilterValue(choice.agentBackend, choice.model)
        : choice.model,
      label: ambiguous
        ? `${agentBackendLabel(choice.agentBackend)} · ${choice.model}`
        : choice.model,
    }
  })
  const selected = input.selectedModel
  if (
    selected !== "" &&
    selected !== UNKNOWN_MODEL_FILTER &&
    !options.some(
      (option) =>
        option.value === selected ||
        option.value === modelFilterValue(input.agentBackend, selected),
    )
  ) {
    options.push({
      value: selected,
      label:
        input.agentBackend === ""
          ? selected
          : `${agentBackendLabel(input.agentBackend)} · ${selected}`,
    })
  }
  return options
}

export function currentModelSelectValue(input: {
  readonly model: string
  readonly agentBackend: string
  readonly options: readonly StatisticsSelectOption[]
}): string {
  if (input.model === "" || input.model === UNKNOWN_MODEL_FILTER) {
    return input.model
  }
  const composite = modelFilterValue(input.agentBackend, input.model)
  if (input.options.some((option) => option.value === composite)) {
    return composite
  }
  return input.model
}

export function modelHistoryDisclosure(input: {
  readonly history: "UNKNOWN" | "PARTIAL" | "COMPLETE"
  readonly models: readonly string[]
}): string {
  const recorded = input.models.length === 0 ? "none" : input.models.join(", ")
  switch (input.history) {
    case "UNKNOWN":
      return "No historical model was recorded for this task. It stays in All models and matches Unknown model. Today's settings are not used to guess a model."
    case "PARTIAL":
      return `Recorded models: ${recorded}. Some agent executions have no recorded model, so this is not a complete history. The task can still match a recorded model, and all of its attempts stay in the totals.`
    case "COMPLETE":
      return `Recorded models: ${recorded}. These are the models selected for this task's agent executions, including build, review, and retries.`
    default: {
      const _exhaustive: never = input.history
      return _exhaustive
    }
  }
}
