import { expect, it } from "@effect/vitest"
import { Effect, ManagedRuntime } from "effect"
import { GitHubThrottledError } from "@ready-for-agent/github-service"
import {
  GitHubOperationCoordinator,
  GitHubOperationCoordinatorLive,
  type GitHubOperationCoordinatorShape,
  type GitHubOperationOrigin,
  makeGitHubOperationCoordinator,
} from "../src/server/github-operation-coordinator.js"

interface ActiveOperationCounter {
  active: number
  maximum: number
}

const controlledOperation = (input: {
  readonly name: string
  readonly started: string[]
  readonly release: Map<string, () => void>
  readonly onStart?: () => void
  readonly activeCounter?: ActiveOperationCounter
}): Effect.Effect<void> => {
  let started = false
  return Effect.callback((resume) => {
    started = true
    input.started.push(input.name)
    if (input.activeCounter !== undefined) {
      input.activeCounter.active += 1
      input.activeCounter.maximum = Math.max(
        input.activeCounter.maximum,
        input.activeCounter.active,
      )
    }
    input.onStart?.()
    input.release.set(input.name, () => resume(Effect.void))
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (started && input.activeCounter !== undefined) {
          input.activeCounter.active -= 1
        }
      }),
    ),
  )
}

const enqueue = (input: {
  readonly coordinator: GitHubOperationCoordinatorShape
  readonly origin: GitHubOperationOrigin
  readonly name: string
  readonly started: string[]
  readonly release: Map<string, () => void>
  readonly activeCounter?: ActiveOperationCounter
}): Promise<void> =>
  Effect.runPromise(
    input.coordinator.execute({
      origin: input.origin,
      operation: controlledOperation(input),
    }),
  )

const waitFor = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) await Promise.resolve()
}

it("serializes mixed-origin operations and admits semantic priority FIFO", async () => {
  const coordinator = makeGitHubOperationCoordinator()
  const started: string[] = []
  const release = new Map<string, () => void>()
  const active = enqueue({
    coordinator,
    origin: "background",
    name: "active",
    started,
    release,
  })
  await waitFor(() => started.length === 1)
  const background = enqueue({
    coordinator,
    origin: "background",
    name: "background",
    started,
    release,
  })
  const polling = enqueue({
    coordinator,
    origin: "polling",
    name: "polling",
    started,
    release,
  })
  const lifecycleFirst = enqueue({
    coordinator,
    origin: "lifecycle",
    name: "lifecycle-first",
    started,
    release,
  })
  const lifecycleSecond = enqueue({
    coordinator,
    origin: "lifecycle",
    name: "lifecycle-second",
    started,
    release,
  })
  const operator = enqueue({
    coordinator,
    origin: "operator",
    name: "operator",
    started,
    release,
  })

  release.get("active")?.()
  await waitFor(() => started.length === 2)
  release.get("operator")?.()
  await waitFor(() => started.length === 3)
  release.get("lifecycle-first")?.()
  await waitFor(() => started.length === 4)
  release.get("lifecycle-second")?.()
  await waitFor(() => started.length === 5)
  release.get("polling")?.()
  await waitFor(() => started.length === 6)
  release.get("background")?.()

  await Promise.all([
    active,
    background,
    polling,
    lifecycleFirst,
    lifecycleSecond,
    operator,
  ])
  expect(started).toEqual([
    "active",
    "operator",
    "lifecycle-first",
    "lifecycle-second",
    "polling",
    "background",
  ])
})

it("never exceeds one active operation", async () => {
  const coordinator = makeGitHubOperationCoordinator()
  const activeCounter = { active: 0, maximum: 0 }
  const started: string[] = []
  const release = new Map<string, () => void>()
  const first = enqueue({
    coordinator,
    origin: "background",
    name: "first",
    started,
    release,
    activeCounter,
  })
  await waitFor(() => started.length === 1)
  const second = enqueue({
    coordinator,
    origin: "operator",
    name: "second",
    started,
    release,
    activeCounter,
  })
  const third = enqueue({
    coordinator,
    origin: "polling",
    name: "third",
    started,
    release,
    activeCounter,
  })

  release.get("first")?.()
  await waitFor(() => started.length === 2)
  release.get("second")?.()
  await waitFor(() => started.length === 3)
  release.get("third")?.()
  await Promise.all([first, second, third])

  expect(activeCounter.maximum).toBe(1)
  expect(activeCounter.active).toBe(0)
})

it("admits the globally oldest request after 60 seconds", async () => {
  let time = 0
  const coordinator = makeGitHubOperationCoordinator({ now: () => time })
  const started: string[] = []
  const release = new Map<string, () => void>()
  const active = enqueue({
    coordinator,
    origin: "operator",
    name: "active",
    started,
    release,
  })
  await waitFor(() => started.length === 1)
  const background = enqueue({
    coordinator,
    origin: "background",
    name: "old-background",
    started,
    release,
  })
  time = 60_000
  const operator = enqueue({
    coordinator,
    origin: "operator",
    name: "new-operator",
    started,
    release,
  })

  release.get("active")?.()
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["active", "old-background"])
  release.get("old-background")?.()
  await waitFor(() => started.length === 3)
  release.get("new-operator")?.()
  await Promise.all([active, background, operator])
})

it("removes cancellation before dispatch without preempting the active operation", async () => {
  const coordinator = makeGitHubOperationCoordinator()
  const started: string[] = []
  const release = new Map<string, () => void>()
  const active = enqueue({
    coordinator,
    origin: "background",
    name: "active",
    started,
    release,
  })
  await waitFor(() => started.length === 1)
  const abort = new AbortController()
  const cancelled = Effect.runPromise(
    coordinator.execute({
      origin: "operator",
      operation: controlledOperation({
        name: "cancelled",
        started,
        release,
      }),
    }),
    { signal: abort.signal },
  ).catch(() => undefined)
  abort.abort()
  await cancelled
  expect(started).toEqual(["active"])

  const next = enqueue({
    coordinator,
    origin: "operator",
    name: "next",
    started,
    release,
  })
  release.get("active")?.()
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["active", "next"])
  release.get("next")?.()
  await Promise.all([active, next])
})

it("keeps an active operation running after its caller cancels", async () => {
  const coordinator = makeGitHubOperationCoordinator()
  const started: string[] = []
  const release = new Map<string, () => void>()
  const abort = new AbortController()
  const active = Effect.runPromise(
    coordinator.execute({
      origin: "lifecycle",
      operation: controlledOperation({ name: "active", started, release }),
    }),
    { signal: abort.signal },
  ).catch(() => undefined)
  await waitFor(() => started.length === 1)
  const next = enqueue({
    coordinator,
    origin: "operator",
    name: "next",
    started,
    release,
  })
  abort.abort()
  await Promise.resolve()
  expect(started).toEqual(["active"])
  release.get("active")?.()
  await waitFor(() => started.length === 2)
  release.get("next")?.()
  await Promise.all([active, next])
})

it("releases waiting work and closes new admission until the throttle deadline", async () => {
  let time = 0
  const coordinator = makeGitHubOperationCoordinator({ now: () => time })
  const started: string[] = []
  const release = new Map<string, () => void>()
  const active = enqueue({
    coordinator,
    origin: "lifecycle",
    name: "active",
    started,
    release,
  })
  await waitFor(() => started.length === 1)

  const waiting = enqueue({
    coordinator,
    origin: "operator",
    name: "waiting",
    started,
    release,
  }).catch((error: unknown) => error)
  const throttle = coordinator.reportThrottle(
    new GitHubThrottledError({ retryAt: 60_000, usedFallback: false }),
  )
  const waitingError = await waiting
  expect(waitingError).toBeInstanceOf(GitHubThrottledError)
  expect(started).toEqual(["active"])
  expect(coordinator.throttleStatus()).toEqual({ retryAt: throttle.retryAt })

  const blocked = enqueue({
    coordinator,
    origin: "operator",
    name: "blocked",
    started,
    release,
  }).catch((error: unknown) => error)
  expect(await blocked).toBeInstanceOf(GitHubThrottledError)
  expect(started).toEqual(["active"])

  release.get("active")?.()
  await active
  time = 60_000
  expect(coordinator.throttleStatus()).toBeNull()
  const resumed = enqueue({
    coordinator,
    origin: "operator",
    name: "resumed",
    started,
    release,
  })
  await waitFor(() => started.length === 2)
  release.get("resumed")?.()
  await resumed
})

it("doubles only repeated deadline-less secondary throttles", () => {
  let time = 0
  const coordinator = makeGitHubOperationCoordinator({ now: () => time })
  const first = coordinator.reportThrottle(
    new GitHubThrottledError({ retryAt: 60_000, usedFallback: true }),
  )
  expect(first.retryAt).toBe(60_000)

  time = 60_000
  expect(coordinator.throttleStatus()).toBeNull()
  const second = coordinator.reportThrottle(
    new GitHubThrottledError({ retryAt: 120_000, usedFallback: true }),
  )
  expect(second.retryAt).toBe(180_000)
})

it("isolates and disposes coordinator state per managed runtime", async () => {
  const firstRuntime = ManagedRuntime.make(GitHubOperationCoordinatorLive)
  const secondRuntime = ManagedRuntime.make(GitHubOperationCoordinatorLive)
  await Promise.all([firstRuntime.context(), secondRuntime.context()])
  const first = await firstRuntime.runPromise(GitHubOperationCoordinator)
  const second = await secondRuntime.runPromise(GitHubOperationCoordinator)
  const started: string[] = []
  const release = new Map<string, () => void>()
  try {
    const firstRun = enqueue({
      coordinator: first,
      origin: "background",
      name: "first-runtime",
      started,
      release,
    })
    const secondRun = enqueue({
      coordinator: second,
      origin: "background",
      name: "second-runtime",
      started,
      release,
    })
    await waitFor(() => started.length === 2)
    expect(started).toEqual(["first-runtime", "second-runtime"])
    release.get("first-runtime")?.()
    release.get("second-runtime")?.()
    await Promise.all([firstRun, secondRun])

    const active = enqueue({
      coordinator: first,
      origin: "background",
      name: "disposing-active",
      started,
      release,
    })
    await waitFor(() => started.length === 3)
    const pending = enqueue({
      coordinator: first,
      origin: "operator",
      name: "disposed-pending",
      started,
      release,
    }).catch(() => undefined)
    await firstRuntime.dispose()
    await pending
    expect(started).toEqual([
      "first-runtime",
      "second-runtime",
      "disposing-active",
    ])
    release.get("disposing-active")?.()
    await active
  } finally {
    await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()])
  }
})
