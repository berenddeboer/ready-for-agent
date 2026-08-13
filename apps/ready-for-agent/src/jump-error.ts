import { Runtime, Schema } from "effect"

/**
 * Interactive Session Continuation failure. Jump is outside the finite JSON
 * command protocol: the CLI writes this message to stderr and exits 1.
 * Marked as already reported so `BunRuntime.runMain` does not pretty-print
 * a stack after the one-line message.
 */
export class JumpFailed extends Schema.TaggedErrorClass<JumpFailed>()(
  "JumpFailed",
  {
    message: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false
}
