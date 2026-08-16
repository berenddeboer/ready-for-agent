import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")
const pinnedUsage = join(workspaceRoot, "scripts", "run-pinned-usage.sh")

export const USAGE_COMPLETION_SHELLS = [
  "bash",
  "zsh",
  "fish",
  "nu",
  "powershell",
] as const

export type UsageCompletionShell = (typeof USAGE_COMPLETION_SHELLS)[number]

const USAGE_SPEC_COMMAND = "ready-for-agent --usage"

const isUsageCompletionShell = (value: string): value is UsageCompletionShell =>
  (USAGE_COMPLETION_SHELLS as readonly string[]).includes(value)

const supportedShellsList = (): string => USAGE_COMPLETION_SHELLS.join(", ")

export const generateUsageCompletion = (input: {
  readonly shell: string
}): string => {
  if (!isUsageCompletionShell(input.shell)) {
    throw new Error(
      `Unknown completion shell "${input.shell}". Supported shells: ${supportedShellsList()}`,
    )
  }

  const result = spawnSync(
    "bash",
    [
      pinnedUsage,
      "generate",
      "completion",
      "--usage-cmd",
      USAGE_SPEC_COMMAND,
      input.shell,
      "ready-for-agent",
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `Pinned Usage failed to generate ${input.shell} completions: ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout ?? ""
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0] === undefined) {
    console.error(
      `Usage: generate-usage-completions.ts <${USAGE_COMPLETION_SHELLS.join("|")}>`,
    )
    process.exitCode = 1
  } else {
    try {
      process.stdout.write(generateUsageCompletion({ shell: args[0] }))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
