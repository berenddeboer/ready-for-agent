import type { AgentBackendProvider } from "@ready-for-agent/agent-backend"
import type { ClaudeAuthProvider } from "./parse-auth-status.js"

/**
 * Map Claude Code `apiProvider` from `claude auth status` to a stable provider
 * identity for Agent Backend status (issue #819). Derived only from Claude's
 * reported field — never from `CLAUDE_CODE_USE_BEDROCK` alone.
 */
export const claudeProviderIdentity = (
  provider: ClaudeAuthProvider,
): AgentBackendProvider | null => {
  if (provider === "bedrock") {
    return { id: "bedrock", label: "Amazon Bedrock" }
  }
  if (provider === "firstParty") {
    return { id: "firstParty", label: "First-party" }
  }
  return null
}
