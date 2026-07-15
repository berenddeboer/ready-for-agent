export const extractOpencodeAssistantText = (stdout: string): string =>
  stdout
    .split("\n")
    .flatMap((line) => {
      try {
        const event: unknown = JSON.parse(line)
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
          return [event.part.text]
        }
      } catch {
        return []
      }
      return []
    })
    .join("\n")
