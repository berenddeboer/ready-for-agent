import type { AgentBackendCapability, AgentBackendDescriptor } from "./types.js"
import { AGENT_BACKEND_IDS, type AgentBackendId } from "./types.js"

/**
 * Built-in Agent Backend registry entry: static descriptor and typed
 * optional capabilities. Consumers resolve through the registry rather than
 * comparing backend IDs for capability checks.
 */
export interface AgentBackendRegistration {
  readonly descriptor: AgentBackendDescriptor
  readonly capabilities: ReadonlyArray<AgentBackendCapability>
}

/** Static operator-facing label for the Claude Code backend (first-party). */
export const CLAUDE_CODE_LABEL = "Claude Code"

/**
 * Operator-facing label when the harness process runs Claude Code in Bedrock
 * configuration mode (`CLAUDE_CODE_USE_BEDROCK=1`). Settings dropdowns use this
 * label; Ready/Unavailable still come from Claude auth inspection (issue #828).
 */
export const CLAUDE_CODE_BEDROCK_LABEL = "Claude Code Bedrock"

/**
 * Configuration mode token exposed on `AgentBackendInfo` when Claude Code is
 * in Bedrock Settings mode. Browser code must not read process env for this.
 */
export const CLAUDE_CODE_BEDROCK_CONFIGURATION_MODE = "bedrock"

/**
 * True when the harness process enables Claude Code Bedrock configuration
 * mode. Only the exact value `"1"` selects the mode (issue #828).
 */
export const isClaudeCodeBedrockConfigurationMode = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean => environment.CLAUDE_CODE_USE_BEDROCK === "1"

/**
 * Operator-facing Agent Backend list entry for Settings (id, label, optional
 * configuration mode). Claude Code becomes **Claude Code Bedrock** with mode
 * `bedrock` when {@link isClaudeCodeBedrockConfigurationMode} is true.
 */
export type SelectableAgentBackendInfo = {
  readonly id: AgentBackendId
  readonly label: string
  /**
   * Settings configuration mode. `bedrock` for Claude Code Bedrock mode;
   * null when the backend has no mode variants or is in its default mode.
   */
  readonly configurationMode: string | null
}

/**
 * Built-in backends as Settings-facing info. Label and configurationMode for
 * Claude Code depend on harness process env; other backends are static.
 */
export const listSelectableAgentBackendInfos = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<SelectableAgentBackendInfo> =>
  listBuiltInAgentBackends().map((entry) => {
    if (
      entry.descriptor.id === AGENT_BACKEND_IDS.claude &&
      isClaudeCodeBedrockConfigurationMode(environment)
    ) {
      return {
        id: entry.descriptor.id,
        label: CLAUDE_CODE_BEDROCK_LABEL,
        configurationMode: CLAUDE_CODE_BEDROCK_CONFIGURATION_MODE,
      }
    }
    return {
      id: entry.descriptor.id,
      label: entry.descriptor.label,
      configurationMode: null,
    }
  })

const OPENCODE_REGISTRATION: AgentBackendRegistration = {
  descriptor: {
    id: AGENT_BACKEND_IDS.opencode,
    label: "OpenCode",
  },
  capabilities: [
    { _tag: "SessionTelemetry", supported: true },
    { _tag: "AgentTurnTail", supported: true },
    { _tag: "KeymaxxerMcp", supported: true },
  ],
}

const GROK_REGISTRATION: AgentBackendRegistration = {
  descriptor: {
    id: AGENT_BACKEND_IDS.grok,
    label: "Grok Build",
  },
  capabilities: [
    { _tag: "SessionTelemetry", supported: true },
    { _tag: "AgentTurnTail", supported: false },
    { _tag: "KeymaxxerMcp", supported: false },
  ],
}

const CODEX_REGISTRATION: AgentBackendRegistration = {
  descriptor: {
    id: AGENT_BACKEND_IDS.codex,
    label: "Codex Build",
  },
  capabilities: [
    { _tag: "SessionTelemetry", supported: true },
    { _tag: "AgentTurnTail", supported: false },
    { _tag: "KeymaxxerMcp", supported: false },
  ],
}

const CLAUDE_REGISTRATION: AgentBackendRegistration = {
  descriptor: {
    id: AGENT_BACKEND_IDS.claude,
    label: CLAUDE_CODE_LABEL,
  },
  capabilities: [
    { _tag: "SessionTelemetry", supported: true },
    { _tag: "AgentTurnTail", supported: false },
    { _tag: "KeymaxxerMcp", supported: false },
  ],
}

/** Production selectable backends registered at build time. */
const BUILT_IN_REGISTRY: ReadonlyArray<AgentBackendRegistration> = [
  OPENCODE_REGISTRATION,
  GROK_REGISTRATION,
  CODEX_REGISTRATION,
  CLAUDE_REGISTRATION,
]

export const listBuiltInAgentBackends =
  (): ReadonlyArray<AgentBackendRegistration> => BUILT_IN_REGISTRY

export const getBuiltInAgentBackend = (
  id: string,
): AgentBackendRegistration | undefined =>
  BUILT_IN_REGISTRY.find((entry) => entry.descriptor.id === id)

export const isSelectableAgentBackendId = (id: string): id is AgentBackendId =>
  getBuiltInAgentBackend(id) !== undefined

/**
 * Operator-visible Agent Backend name for failure copy and UI provenance.
 * Known built-in ids use their registry label (e.g. "Grok Build"); unknown
 * ids fall back to the raw id so copy still names something concrete.
 */
export const agentBackendLabel = (backendId: string): string =>
  getBuiltInAgentBackend(backendId)?.descriptor.label ?? backendId

export const defaultAgentBackendId = AGENT_BACKEND_IDS.opencode

export const capabilitySupported = (
  registration: AgentBackendRegistration,
  tag: AgentBackendCapability["_tag"],
): boolean => {
  const capability = registration.capabilities.find(
    (entry) => entry._tag === tag,
  )
  if (capability === undefined) {
    return false
  }
  return capability.supported === true
}
