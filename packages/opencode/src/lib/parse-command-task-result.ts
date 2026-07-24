export const normalizeCommandName = (command: string): string =>
  command.startsWith("/") ? command.slice(1) : command

const taskResultFromOutput = (output: string): string | undefined => {
  const match = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i.exec(output)
  if (match === null) {
    return undefined
  }
  const text = match[1]?.trim() ?? ""
  return text.length > 0 ? text : undefined
}

/**
 * When OpenCode runs `--command`, the command agent executes as a nested task
 * subsession. Its ordered final assistant text is only observable on the parent
 * stream as a completed `tool_use` task part (`state.output`), not as parent
 * `type:"text"` events. Parent text after that is the automatic "summarize and
 * continue" resume and must not be treated as the command result.
 */
export const parseCommandTaskResultFromLine = (
  line: string,
  commandName: string,
): string | undefined => {
  const wanted = normalizeCommandName(commandName)
  if (wanted.length === 0) {
    return undefined
  }

  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  try {
    const event: unknown = JSON.parse(trimmed)
    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      event.type !== "tool_use" ||
      !("part" in event) ||
      typeof event.part !== "object" ||
      event.part === null
    ) {
      return undefined
    }

    const part = event.part
    if (
      !("type" in part) ||
      part.type !== "tool" ||
      !("tool" in part) ||
      part.tool !== "task" ||
      !("state" in part) ||
      typeof part.state !== "object" ||
      part.state === null
    ) {
      return undefined
    }

    const state = part.state
    if (
      !("status" in state) ||
      state.status !== "completed" ||
      !("input" in state) ||
      typeof state.input !== "object" ||
      state.input === null ||
      !("command" in state.input) ||
      typeof state.input.command !== "string" ||
      normalizeCommandName(state.input.command) !== wanted ||
      !("output" in state) ||
      typeof state.output !== "string"
    ) {
      return undefined
    }

    return taskResultFromOutput(state.output)
  } catch {
    return undefined
  }
}
