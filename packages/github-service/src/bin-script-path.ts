import { fileURLToPath } from "node:url"

/**
 * Absolute path to a github-service CLI script under `src/bin`.
 * Callers may run these with any cwd (e.g. $HOME for host tools).
 */
export const githubServiceBinScriptPath = (scriptFileName: string): string =>
  fileURLToPath(new URL(`./bin/${scriptFileName}`, import.meta.url))
