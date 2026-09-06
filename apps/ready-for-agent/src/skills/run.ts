import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { encodeCompactJson } from "../cli-json.ts"
import { READY_FOR_AGENT_VERSION } from "../generated/version.ts"
import { skillsCommand } from "./command.ts"

const FLAGS_WITH_VALUES = new Set(["--log-level", "--completions"])

/** Root start flags belong to the full CLI, not the offline skills fast path. */
const ROOT_START_FLAGS = new Set(["--host", "--no-open"])

/** True when the first non-global-flag token is `skills`. */
export const isSkillsInvocation = (userArgs: readonly string[]): boolean => {
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index]
    if (arg === undefined || arg === "--") {
      return false
    }
    if (arg === "skills") {
      return true
    }
    if (!arg.startsWith("-")) {
      return false
    }
    const flagName = arg.split("=")[0] ?? arg
    if (ROOT_START_FLAGS.has(flagName)) {
      return false
    }
    if (FLAGS_WITH_VALUES.has(flagName) && !arg.includes("=")) {
      index += 1
    }
  }
  return false
}

export const runSkillsProcess = (userArgs: readonly string[]): void => {
  const program = Command.runWith(
    Command.make("ready-for-agent").pipe(
      Command.withSubcommands([skillsCommand]),
    ),
    { version: READY_FOR_AGENT_VERSION },
  )(userArgs).pipe(
    Effect.provide(BunServices.layer),
    Effect.tapErrorTag("FiniteCommandFailed", (error) =>
      Effect.sync(() => {
        console.error(encodeCompactJson(error.document))
      }),
    ),
  )

  BunRuntime.runMain(program)
}
