import { Context, Effect, Layer } from "effect"
import type { GitHubOperationOrigin } from "@ready-for-agent/github-service"

export type { GitHubOperationOrigin } from "@ready-for-agent/github-service"

const originAdmissionOrder: readonly GitHubOperationOrigin[] = [
  "operator",
  "lifecycle",
  "polling",
  "background",
]
const AGING_MILLIS = 60_000

export interface GitHubOperationCoordinatorShape {
  /**
   * Runs one replay-safe Harness GitHub Operation while holding the sole
   * process-local permit. The operation may make sequential requests only.
   */
  readonly execute: <A, E>(input: {
    readonly origin: GitHubOperationOrigin
    readonly operation: Effect.Effect<A, E>
  }) => Effect.Effect<A, E>
}

export class GitHubOperationCoordinator extends Context.Service<
  GitHubOperationCoordinator,
  GitHubOperationCoordinatorShape
>()("@ready-for-agent/harness/GitHubOperationCoordinator") {}

interface WaitingOperation {
  readonly origin: GitHubOperationOrigin
  readonly enqueuedAt: number
  readonly start: () => void
  readonly interrupt: () => void
  started: boolean
}

interface CoordinatorState extends GitHubOperationCoordinatorShape {
  readonly dispose: () => void
}

/**
 * Construct an isolated coordinator. The injected clock makes admission tests
 * deterministic; production uses wall-clock milliseconds.
 */
export const makeGitHubOperationCoordinator = (options?: {
  readonly now?: () => number
}): CoordinatorState => {
  const now = options?.now ?? Date.now
  const waiting: WaitingOperation[] = []
  let active: WaitingOperation | undefined
  let disposed = false

  const remove = (operation: WaitingOperation): void => {
    const index = waiting.indexOf(operation)
    if (index !== -1) waiting.splice(index, 1)
  }

  const selectNext = (): WaitingOperation | undefined => {
    const currentTime = now()
    for (const operation of waiting) {
      if (currentTime - operation.enqueuedAt >= AGING_MILLIS) return operation
    }
    for (const origin of originAdmissionOrder) {
      const next = waiting.find((operation) => operation.origin === origin)
      if (next !== undefined) return next
    }
    return undefined
  }

  const admitNext = (): void => {
    if (disposed || active !== undefined) return
    const next = selectNext()
    if (next === undefined) return
    remove(next)
    next.started = true
    active = next
    next.start()
  }

  const release = (operation: WaitingOperation): void => {
    if (active !== operation) return
    active = undefined
    admitNext()
  }

  const execute: GitHubOperationCoordinatorShape["execute"] = (input) =>
    Effect.callback((resume) => {
      let operation: WaitingOperation
      operation = {
        origin: input.origin,
        enqueuedAt: now(),
        started: false,
        interrupt: () => resume(Effect.interrupt),
        start: () => {
          resume(
            Effect.uninterruptible(input.operation).pipe(
              Effect.ensuring(Effect.sync(() => release(operation))),
            ),
          )
        },
      }
      if (disposed) {
        operation.interrupt()
      } else {
        waiting.push(operation)
        admitNext()
      }
      return Effect.sync(() => {
        if (operation.started) return
        remove(operation)
        admitNext()
      })
    })

  return {
    execute,
    dispose: () => {
      if (disposed) return
      disposed = true
      const pending = waiting.splice(0)
      for (const operation of pending) operation.interrupt()
    },
  }
}

/** One coordinator is scoped to the Harness application runtime that builds it. */
export const GitHubOperationCoordinatorLive = Layer.effect(
  GitHubOperationCoordinator,
  Effect.acquireRelease(
    Effect.sync(() => makeGitHubOperationCoordinator()),
    (coordinator) => Effect.sync(coordinator.dispose),
  ),
)
