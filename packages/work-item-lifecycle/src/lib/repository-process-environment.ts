import {
  HARNESS_OWNED_ENVIRONMENT_NAMES,
  sanitizeInheritedEnvironment,
} from "@ready-for-agent/agent-backend"

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
