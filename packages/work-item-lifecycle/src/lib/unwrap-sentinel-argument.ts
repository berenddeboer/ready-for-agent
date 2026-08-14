/**
 * Strip one surrounding pair of angle brackets from a READY_FOR_AGENT_RESULT
 * argument. Agents sometimes copy placeholder brackets from the prompt
 * (`<medium>`). The placeholder itself (`<low|medium|high>`) still fails
 * subsequent enum matching after unwrap.
 */
export const unwrapSentinelArgument = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}
