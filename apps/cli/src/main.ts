import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { cli } from "./cli.ts"
import { LocalGit } from "./services/local-git.ts"

const MainLive = LocalGit.layer.pipe(Layer.provideMerge(BunServices.layer))

const program = Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide(MainLive),
)

BunRuntime.runMain(program)
