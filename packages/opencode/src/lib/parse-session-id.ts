export const parseSessionIdFromLine = (line: string): string | undefined => {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sessionID" in parsed &&
      typeof parsed.sessionID === "string" &&
      parsed.sessionID.length > 0
    ) {
      return parsed.sessionID
    }
  } catch {
    return undefined
  }

  return undefined
}

export const parseSessionIdFromLines = (
  lines: Iterable<string>,
): string | undefined => {
  let sessionId: string | undefined
  for (const line of lines) {
    const parsed = parseSessionIdFromLine(line)
    if (parsed !== undefined) {
      sessionId = parsed
    }
  }
  return sessionId
}
