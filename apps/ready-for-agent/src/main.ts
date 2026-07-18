#!/usr/bin/env bun
import {
  isInternalKeymaxxerSidecarMode,
  runKeymaxxerSidecarProcess,
} from "@ready-for-agent/keymaxxer-service"

if (isInternalKeymaxxerSidecarMode(process.argv)) {
  await runKeymaxxerSidecarProcess()
} else {
  const { BunRuntime, BunServices } = await import("@effect/platform-bun")
  const { Effect, Layer } = await import("effect")
  const { Command } = await import("effect/unstable/cli")
  const { cli } = await import("./cli.ts")
  const { GraphqlApi } = await import("./services/graphql-api.ts")
  const { LocalGit } = await import("./services/local-git.ts")
  const { StartHarness } = await import("./services/start-harness.ts")

  const MainLive = LocalGit.layer.pipe(
    Layer.provideMerge(GraphqlApi.layer),
    Layer.provideMerge(StartHarness.layer),
    Layer.provideMerge(BunServices.layer),
  )

  const program = Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.provide(MainLive),
  )

  BunRuntime.runMain(program)
}
