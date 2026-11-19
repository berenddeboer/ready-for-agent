import { Effect, Exit, Fiber } from "effect"
import {
  AgentBackendConfigError,
  type AgentBackendError,
  type PendingImplementStop,
  type TrackImplementStop,
} from "@ready-for-agent/agent-backend"
import {
  buildSessionInterruptApiArgs,
  buildSessionRecentUserMessagesApiArgs,
  buildSessionWaitApiArgs,
} from "./build-args.js"
import { type StopCapture, jsonRecord } from "./implement-stop-target.js"

const normalizePrompt = (text: string): string =>
  text.trim().replace(/\s+/g, " ")

const promptIds = (stdout: string, prompt: string): string[] | undefined => {
  const data = jsonRecord(stdout)?.data
  if (!Array.isArray(data)) return undefined
  return data.flatMap((message: unknown) =>
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    "id" in message &&
    "text" in message &&
    message.type === "user" &&
    typeof message.id === "string" &&
    typeof message.text === "string" &&
    normalizePrompt(message.text) === prompt
      ? [message.id]
      : [],
  )
}

/**
 * Keep the run client alive during cancellation until the server has admitted
 * its prompt or the client has finished normally. An idle response before
 * submission is not a stop: the run client could still submit after it.
 */
export const runStoppablePlainPrompt = <A>(input: {
  readonly target: PendingImplementStop
  readonly prompt: string
  readonly resumed: boolean
  readonly capture: StopCapture
  readonly run: Effect.Effect<A, AgentBackendError>
  readonly track: TrackImplementStop
  readonly verifyIdle: Effect.Effect<void, AgentBackendError>
}): Effect.Effect<A, AgentBackendError> =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { target, track } = input
        const { sessionId } = target
        const prompt = normalizePrompt(input.prompt)
        // Assistant output can fill a page long before the turn goes idle.
        // Filter on the server so the submitted user prompt stays visible.
        const messages = input
          .capture(buildSessionRecentUserMessagesApiArgs(sessionId))
          .pipe(Effect.map(({ stdout }) => promptIds(stdout, prompt)))
        // Snapshot only resumed sessions. The fresh ID is reserved by this
        // invocation; there is no earlier prompt to mistake for its submission.
        const previous = input.resumed ? yield* restore(messages) : []
        if (previous === undefined) {
          return yield* new AgentBackendConfigError({
            message: `OpenCode could not read session ${sessionId} before resuming Implement.`,
          })
        }
        const failure = (cause: unknown) =>
          new AgentBackendConfigError({
            message: `Could not confirm that OpenCode session ${sessionId} stopped. Check the original OpenCode server, stop the session if active, then retry Reset.`,
            cause,
          })
        yield* track.started(target).pipe(Effect.mapError(failure))

        let finished: Exit.Exit<A, AgentBackendError> | undefined
        const completed = () =>
          finished !== undefined && Exit.isSuccess(finished)
        const clear = track.stopped(target).pipe(Effect.mapError(failure))
        const confirmStopped = Effect.gen(function* () {
          while (!completed()) {
            const current = yield* messages.pipe(
              Effect.orElseSucceed(() => undefined),
            )
            if (completed()) return
            if (current?.some((id) => !previous.includes(id)) === true) {
              const { stdout } = yield* input.capture(
                buildSessionInterruptApiArgs(sessionId),
              )
              if (typeof jsonRecord(stdout)?.interrupted !== "boolean") {
                return yield* Effect.fail(
                  "OpenCode did not acknowledge the interrupt",
                )
              }
              yield* input.capture(buildSessionWaitApiArgs(sessionId))
              return
            }
            if (finished !== undefined) {
              // The client may have failed before submitting anything. Do
              // not wait indefinitely for a message that may never appear.
              yield* input.verifyIdle
              return
            }
            yield* Effect.sleep("100 millis")
          }
        }).pipe(
          Effect.interruptible,
          Effect.timeout("10 seconds"),
          Effect.mapError(failure),
          Effect.andThen(clear),
        )
        const turn = yield* input.run.pipe(
          restore,
          Effect.onExit((exit) =>
            Effect.sync(() => {
              finished = exit
            }),
          ),
          Effect.forkScoped,
        )
        const result = yield* restore(Fiber.await(turn)).pipe(
          // Never retain an interrupt closure for a later Reset. If this
          // fails, the durable obligation stays and Reset only verifies idle.
          Effect.onInterrupt(() => Effect.ignore(confirmStopped)),
        )
        if (Exit.isSuccess(result)) {
          yield* clear
        } else {
          yield* confirmStopped
        }
        return yield* result
      }),
    ),
  )
