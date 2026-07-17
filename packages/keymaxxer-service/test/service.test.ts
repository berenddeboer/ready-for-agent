import { Effect } from "effect"
import { KeymaxxerService, disabledKeymaxxerLayer } from "../src/index.js"
import { expect, test } from "bun:test"

test("disabled Keymaxxer runs commands through the ambient environment", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const keymaxxer = yield* KeymaxxerService
      return yield* keymaxxer.runWithSecrets({
        command: `node -e 'process.stdout.write("ambient-auth")'`,
        cwd: process.cwd(),
        secrets: [],
        timeoutMs: 5_000,
      })
    }).pipe(Effect.provide(disabledKeymaxxerLayer)),
  )

  expect(result).toEqual({
    exitCode: 0,
    stdout: "ambient-auth",
    stderr: "",
  })
})
