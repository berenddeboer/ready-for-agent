/**
 * Source-mode Keymaxxer child entrypoint for open non-draft PR counts.
 *
 * Kept deliberately free of the full Effect/GitHubService/genql helper graph so
 * development Keymaxxer children start without loading every GitHub operation.
 * Product binaries re-enter via {@link runGitHubHelperProcess} and also run this
 * lightweight count body (but the product re-entry module may still load other
 * helper imports for non-count operations — cold-start savings are mainly here).
 */
import { writeSync } from "node:fs"
import { runOpenNonDraftPullRequestCountCli } from "../lib/open-non-draft-pull-request-count.js"

/**
 * Run the count CLI and terminate the process.
 * Uses synchronous stdio + `process.exit` so (1) HTTP keep-alive from `fetch`
 * cannot leave a Keymaxxer child hung until the run timeout, and (2) a tiny
 * success payload is fully flushed before exit (async write + exit can drop
 * buffered digits, which the harness would decode as a false zero).
 */
export const runCountOpenNonDraftPullRequestsProgram = (
  args: ReadonlyArray<string>,
): Promise<never> =>
  runOpenNonDraftPullRequestCountCli(args).then((result) => {
    if (result.stdout !== "") {
      writeSync(1, result.stdout)
    }
    if (result.stderr !== "") {
      writeSync(2, result.stderr)
    }
    process.exit(result.exitCode)
  })

if (import.meta.main) {
  void runCountOpenNonDraftPullRequestsProgram(process.argv.slice(2))
}
