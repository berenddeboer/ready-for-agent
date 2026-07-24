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

const OPENCODE_REGISTRATION: AgentBackendRegistration = {
  descriptor: {
    id: AGENT_BACKEND_IDS.opencode,
    label: "OpenCode",
  },
  capabilities: [
    { _tag: "SessionTelemetry", supported: true },
    { _tag: "KeymaxxerMcp", supported: true },
  ],
}

const GROK_REGISTRATION: AgentBackendRegistration = {
  descriptor: {
    id: AGENT_BACKEND_IDS.grok,
    label: "Grok Build",
  },
  capabilities: [
    { _tag: "SessionTelemetry", supported: false },
    { _tag: "KeymaxxerMcp", supported: false },
  ],
}

/** Production selectable backends registered at build time. */
const BUILT_IN_REGISTRY: ReadonlyArray<AgentBackendRegistration> = [
  OPENCODE_REGISTRATION,
  GROK_REGISTRATION,
]

export const listBuiltInAgentBackends =
  (): ReadonlyArray<AgentBackendRegistration> => BUILT_IN_REGISTRY

export const getBuiltInAgentBackend = (
  id: string,
): AgentBackendRegistration | undefined =>
  BUILT_IN_REGISTRY.find((entry) => entry.descriptor.id === id)

export const isSelectableAgentBackendId = (id: string): id is AgentBackendId =>
  getBuiltInAgentBackend(id) !== undefined

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
