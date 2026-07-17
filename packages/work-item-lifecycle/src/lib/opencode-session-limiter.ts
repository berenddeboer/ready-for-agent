import { Duration, Effect, Option, Semaphore } from "effect"
import type { DbServiceShape } from "@ready-for-agent/db-service"
import type {
  ContinueInput,
  ListModelsInput,
  OpencodeError,
  OpencodeRunResult,
  StartInput,
} from "@ready-for-agent/opencode"
import { Opencode } from "@ready-for-agent/opencode"

const DEFAULT_MAX_CONCURRENT_OPENCODE_SESSIONS = 2
const CONFIG_RECHECK_INTERVAL = Duration.millis(200)

export interface OpencodeService {
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<OpencodeRunResult, OpencodeError>
  readonly continue: (
    input: ContinueInput,
  ) => Effect.Effect<OpencodeRunResult, OpencodeError>
  readonly listModels: (
    input: ListModelsInput,
  ) => Effect.Effect<ReadonlyArray<string>, OpencodeError>
}

/**
 * Cap concurrent lifecycle OpenCode `start`/`continue` processes using the
 * current harness Config value. `listModels` is not wrapped.
 *
 * Re-reads Config on each acquire attempt and resizes the semaphore so raising
 * the limit frees capacity promptly and lowering it does not interrupt
 * in-flight processes (they finish; new acquires wait until taken drops).
 */
export const limitOpencodeSessions = (
  opencode: OpencodeService,
  db: Pick<DbServiceShape, "getConfig">,
): Effect.Effect<OpencodeService> =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(
      DEFAULT_MAX_CONCURRENT_OPENCODE_SESSIONS,
    )

    const currentMax = db.getConfig.pipe(
      Effect.map((config) => Math.max(1, config.maxConcurrentOpencodeSessions)),
      Effect.orElseSucceed(() => DEFAULT_MAX_CONCURRENT_OPENCODE_SESSIONS),
    )

    const withSessionSlot = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        for (;;) {
          const max = yield* currentMax
          yield* semaphore.resize(max)
          const result = yield* semaphore.withPermitsIfAvailable(1)(effect)
          if (Option.isSome(result)) {
            return result.value
          }
          yield* Effect.sleep(CONFIG_RECHECK_INTERVAL)
        }
      })

    return Opencode.of({
      start: (input) => withSessionSlot(opencode.start(input)),
      continue: (input) => withSessionSlot(opencode.continue(input)),
      listModels: (input) => opencode.listModels(input),
    })
  })
