const gitCommandSegment = /(^|[;&|]\s*)git\b[^|;&\n]*/g
const gitWithLeadingOptions = String.raw`git\s+(?:-\S+\s+\S+\s+)*`

const bashCommandRules = [
  {
    matches: (command) => /--skip-nx-cache/.test(command),
    message:
      "BLOCKED: Using the --skip-nx-cache parameter is forbidden as this is very bad for performance. You seldom need this, if you need it, ask the user to do it.",
  },
  {
    matches: (command) => /(^|\s)NX_DAEMON=false(\s|$)/.test(command),
    message:
      "BLOCKED: Setting NX_DAEMON=false is forbidden. Do not disable the Nx daemon in tool calls.",
  },
  {
    matches: (command) =>
      [
        new RegExp(`${gitWithLeadingOptions}commit\\s+.*--amend`),
        new RegExp(`${gitWithLeadingOptions}rebase\\s+.*(-i|--interactive)`),
        new RegExp(`${gitWithLeadingOptions}commit\\s+.*--fixup`),
        new RegExp(`${gitWithLeadingOptions}commit\\s+.*--squash`),
      ].some((pattern) => pattern.test(command)),
    message:
      "BLOCKED: Amending/rebasing commits is forbidden. Create new commits only.",
  },
  {
    matches: (command) => {
      for (const match of command.matchAll(gitCommandSegment)) {
        const segment = match[0]

        if (/\s--no-verify(\s|$)/.test(segment)) {
          return true
        }

        if (/\bgit\s+commit\b/.test(segment) && /\s-n(\s|$)/.test(segment)) {
          return true
        }
      }

      return false
    },
    message: "BLOCKED: Skipping git hooks with --no-verify is forbidden.",
  },
]

export const StopDumbToolCallsPlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") {
        return
      }

      const command = output.args.command || ""

      for (const rule of bashCommandRules) {
        if (rule.matches(command)) {
          throw new Error(
            typeof rule.message === "function"
              ? rule.message(command)
              : rule.message,
          )
        }
      }
    },
  }
}
