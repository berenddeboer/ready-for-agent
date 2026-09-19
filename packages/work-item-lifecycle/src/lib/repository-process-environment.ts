import { Effect } from "effect"
import {
  HARNESS_OWNED_ENVIRONMENT_NAMES,
  acquireInvocation,
  invocationCommand,
  sanitizeInheritedEnvironment,
} from "@ready-for-agent/agent-backend"
import type { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"

/** Repository-controlled commands may run hooks or package lifecycle scripts. */
export const repositoryProcessOptions = () => ({
  env: sanitizeInheritedEnvironment(process.env, {
    stripForgeTokens: false,
  }),
  extendEnv: false as const,
})

/** Shell prefix for commands executed by the separately hosted Keymaxxer child. */
export const SANITIZED_REPOSITORY_SHELL_PREFIX = [
  "env",
  ...HARNESS_OWNED_ENVIRONMENT_NAMES.flatMap((name) => ["-u", name]),
].join(" ")

/** Establish ownership in the Harness before the sidecar can execute a hook. */
export const runOwnedWithSecrets = (
  keymaxxer: typeof KeymaxxerService.Service,
  input: Parameters<(typeof KeymaxxerService.Service)["runWithSecrets"]>[0],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const boundary = yield* acquireInvocation({
        cwd: input.cwd ?? process.cwd(),
      })
      const launch = invocationCommand(boundary.membership, "bash", [
        "-c",
        input.command,
      ])
      const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
      return yield* keymaxxer.runWithSecrets({
        ...input,
        command: [launch.command, ...launch.args].map(quote).join(" "),
      })
    }),
  )
