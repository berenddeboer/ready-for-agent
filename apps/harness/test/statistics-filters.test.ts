import {
  UNKNOWN_MODEL_FILTER,
  backendSelectOptions,
  currentModelSelectValue,
  modelHistoryDisclosure,
  modelSelectOptions,
  parseModelFilterValue,
  parseStatisticsAgentBackend,
  parseStatisticsModel,
  statisticsExplorerKey,
  timingHistoryQueryKey,
} from "../src/statistics-filters.js"
import { describe, expect, test } from "bun:test"

describe("statistics backend and model filters", () => {
  test("scopes model choices and keeps a no-match selection visible", () => {
    const choices = [
      { agentBackend: "opencode", model: "anthropic/claude-sonnet" },
      { agentBackend: "codex", model: "anthropic/claude-sonnet" },
      { agentBackend: "opencode", model: "openai/gpt-5" },
    ]
    expect(
      modelSelectOptions({
        choices,
        agentBackend: "opencode",
        selectedModel: "",
      }).map((option) => option.label),
    ).toEqual(["anthropic/claude-sonnet", "openai/gpt-5"])
    const ambiguous = modelSelectOptions({
      choices,
      agentBackend: "",
      selectedModel: "",
    })
    expect(ambiguous.map((option) => option.label)).toEqual([
      "OpenCode · anthropic/claude-sonnet",
      "Codex Build · anthropic/claude-sonnet",
      "openai/gpt-5",
    ])
    expect(parseModelFilterValue(ambiguous[0]?.value ?? "")).toEqual({
      agentBackend: "opencode",
      model: "anthropic/claude-sonnet",
    })
    expect(
      modelSelectOptions({
        choices,
        agentBackend: "grok",
        selectedModel: "missing-model",
      }).map((option) => option.value),
    ).toEqual(["missing-model"])
  })

  test("query identity and explorer pagination change with each filter", () => {
    const base = {
      repositoryId: "repo",
      window: "this-week",
      agentBackend: "",
      model: "",
    }
    expect(timingHistoryQueryKey(base)).not.toEqual(
      timingHistoryQueryKey({ ...base, agentBackend: "opencode" }),
    )
    expect(timingHistoryQueryKey(base)).not.toEqual(
      timingHistoryQueryKey({ ...base, model: UNKNOWN_MODEL_FILTER }),
    )
    expect(
      statisticsExplorerKey({
        repository: "repo",
        window: "this-week",
        agentBackend: "",
        model: "",
      }),
    ).not.toBe(
      statisticsExplorerKey({
        repository: "repo",
        window: "this-week",
        agentBackend: "",
        model: "openai/gpt-5",
      }),
    )
  })

  test("rejects invalid URL values without widening a valid selection", () => {
    expect(parseStatisticsAgentBackend("opencode")).toBe("opencode")
    expect(parseStatisticsAgentBackend(28)).toBe("")
    expect(parseStatisticsAgentBackend("x".repeat(65))).toBe("")
    expect(parseStatisticsModel(UNKNOWN_MODEL_FILTER)).toBe(
      UNKNOWN_MODEL_FILTER,
    )
    expect(parseStatisticsModel("  provider/model  ")).toBe("provider/model")
    expect(
      backendSelectOptions({
        backends: ["opencode"],
        selected: "retired-backend",
      }).map((option) => option.value),
    ).toEqual(["opencode", "retired-backend"])
    const options = modelSelectOptions({
      choices: [{ agentBackend: "opencode", model: "openai/gpt-5" }],
      agentBackend: "opencode",
      selectedModel: "openai/gpt-5",
    })
    expect(
      currentModelSelectValue({
        model: "openai/gpt-5",
        agentBackend: "opencode",
        options,
      }),
    ).toBe("openai/gpt-5")
  })

  test("discloses incomplete historical model identity", () => {
    expect(
      modelHistoryDisclosure({ history: "UNKNOWN", models: [] }),
    ).toContain("not used to guess")
    expect(
      modelHistoryDisclosure({
        history: "PARTIAL",
        models: ["provider/build"],
      }),
    ).toContain("not a complete history")
    expect(
      modelHistoryDisclosure({
        history: "COMPLETE",
        models: ["provider/build", "provider/review"],
      }),
    ).toContain("provider/review")
  })
})
