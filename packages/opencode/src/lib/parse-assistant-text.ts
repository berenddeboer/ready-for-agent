export const parseAssistantTextFromLine = (
  line: string,
): string | undefined => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined

  try {
    const event: unknown = JSON.parse(trimmed)
    if (
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "text" &&
      "part" in event &&
      typeof event.part === "object" &&
      event.part !== null &&
      "type" in event.part &&
      event.part.type === "text" &&
      "text" in event.part &&
      typeof event.part.text === "string"
    ) {
      return event.part.text
    }
  } catch {
    return undefined
  }
  return undefined
}
