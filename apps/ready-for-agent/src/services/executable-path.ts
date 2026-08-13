import { Context, Effect, Layer } from "effect"
import { JumpFailed } from "../jump-error.ts"

export class ExecutablePath extends Context.Service<
  ExecutablePath,
  {
    readonly resolve: (command: string) => Effect.Effect<string, JumpFailed>
  }
>()("ready-for-agent/ExecutablePath") {
  static readonly layer = Layer.sync(ExecutablePath, () => {
    const resolve = Effect.fn("ExecutablePath.resolve")(function* (
      command: string,
    ) {
      const resolved = Bun.which(command)
      if (resolved === null) {
        return yield* new JumpFailed({
          message: `Agent Backend executable '${command}' is not on PATH`,
        })
      }
      return resolved
    })

    return { resolve }
  })
}
