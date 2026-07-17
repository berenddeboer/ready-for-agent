#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { cli } from "./cli.ts"
import { GraphqlApi } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"
import { StartHarness } from "./services/start-harness.ts"

const MainLive = LocalGit.layer.pipe(
  Layer.provideMerge(GraphqlApi.layer),
  Layer.provideMerge(StartHarness.layer),
  Layer.provideMerge(BunServices.layer),
)

const program = Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide(MainLive),
)

BunRuntime.runMain(program)
