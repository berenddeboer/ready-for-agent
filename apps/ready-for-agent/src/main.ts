#!/usr/bin/env bun
import {
  isInternalGitHubHelperMode,
  runGitHubHelperProcess,
} from "@ready-for-agent/github-service"
import {
  isInternalGitLabHelperMode,
  runGitLabHelperProcess,
} from "@ready-for-agent/gitlab-service"
import {
  isInternalKeymaxxerSidecarMode,
  runKeymaxxerSidecarProcess,
} from "@ready-for-agent/keymaxxer-service"
import { READY_FOR_AGENT_VERSION } from "./generated/version.ts"

if (isInternalKeymaxxerSidecarMode(process.argv)) {
  await runKeymaxxerSidecarProcess()
} else if (isInternalGitHubHelperMode(process.argv)) {
  runGitHubHelperProcess()
} else if (isInternalGitLabHelperMode(process.argv)) {
  runGitLabHelperProcess()
} else {
  const { BunRuntime, BunServices } = await import("@effect/platform-bun")
  const { Effect, Layer } = await import("effect")
  const { Command } = await import("effect/unstable/cli")
  const { expandBareHostFlag } = await import(
    "../../harness/src/server/listen-host.ts"
  )
  const { cli } = await import("./cli.ts")
  const { ApplicationConfig } = await import("./services/application-config.ts")
  const { ExecutablePath } = await import("./services/executable-path.ts")
  const { GraphqlApi } = await import("./services/graphql-api.ts")
  const { LocalGit } = await import("./services/local-git.ts")
  const { StartHarness } = await import("./services/start-harness.ts")
  const { Tmux } = await import("./services/tmux.ts")

  const MainLive = Layer.mergeAll(
    LocalGit.layer,
    GraphqlApi.layer,
    StartHarness.layer,
    Tmux.layer,
    ExecutablePath.layer,
  ).pipe(
    Layer.provideMerge(ApplicationConfig.layer),
    Layer.provideMerge(BunServices.layer),
  )

  // Expand bare `--host` → `--host 0.0.0.0` before Effect's string flag parser.
  const args = expandBareHostFlag(process.argv.slice(2))

  const { encodeCompactJson } = await import("./cli-json.ts")

  const program = Command.runWith(cli, {
    version: READY_FOR_AGENT_VERSION,
  })(args).pipe(
    Effect.provide(MainLive),
    // FiniteCommandFailed is marked [Runtime.errorReported]=false so runMain
    // skips Cause pretty-print; emit one versioned JSON error on stderr.
    Effect.tapErrorTag("FiniteCommandFailed", (error) =>
      Effect.sync(() => {
        console.error(encodeCompactJson(error.document))
      }),
    ),
    Effect.tapErrorTag("JumpFailed", (error) =>
      Effect.sync(() => {
        console.error(error.message)
      }),
    ),
  )

  BunRuntime.runMain(program)
}
