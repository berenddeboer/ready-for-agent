import { spawn } from "node:child_process"
import { Data, Effect, Schedule } from "effect"

export type BrowserOpenEnv = Partial<
  Record<"NO_BROWSER" | "PORT" | "HOST", string | undefined>
>

const DEFAULT_UI_PORT = 6056
const DEFAULT_UI_HOST = "127.0.0.1"
/** Overall deadline for the readiness poll (Effect.timeout). */
const DEFAULT_READY_TIMEOUT = "60 seconds" as const
/** Delay between failed probe attempts (Schedule.spaced). */
const DEFAULT_POLL_INTERVAL = "250 millis" as const

/** Minimal child surface used by the detached browser launcher (testable). */
type DetachedBrowserChild = {
  on(event: "error", listener: (error: Error) => void): unknown
  unref(): unknown
}

/** Minimal spawn surface used by the detached browser launcher (testable). */
export type BrowserSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly detached: true
    readonly stdio: "ignore"
  },
) => DetachedBrowserChild

/** Whether start should open the default browser to the local UI. */
export const shouldOpenBrowser = (input: {
  readonly noOpenFlag: boolean
  readonly env: BrowserOpenEnv
}): boolean => {
  if (input.noOpenFlag) {
    return false
  }

  const raw = input.env.NO_BROWSER?.trim().toLowerCase()
  if (raw === undefined || raw === "") {
    return true
  }

  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return true
  }

  return false
}

export const resolveUiUrl = (
  env: BrowserOpenEnv = {},
  host: string = DEFAULT_UI_HOST,
): string => {
  const port = Number(env.PORT ?? DEFAULT_UI_PORT)
  const safePort =
    Number.isInteger(port) && port >= 1 && port <= 65_535
      ? port
      : DEFAULT_UI_PORT
  return `http://${host}:${safePort}/`
}

export const browserOpenCommand = (
  platform: string,
  url: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  if (platform === "darwin") {
    return { command: "open", args: [url] }
  }

  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] }
  }

  return { command: "xdg-open", args: [url] }
}

/**
 * Detached best-effort browser launch.
 *
 * Spawn failures (missing `xdg-open`, etc.) arrive on the child `error` event,
 * not as a synchronous throw. Register that handler before `unref()` so the
 * host process cannot terminate from an unhandled spawn error. The GUI process
 * remains detached — callers never own browser lifetime.
 */
export const launchDetachedBrowser = (
  platform: string,
  url: string,
  spawnImpl: BrowserSpawn = spawn as BrowserSpawn,
): void => {
  const { command, args } = browserOpenCommand(platform, url)
  try {
    const child = spawnImpl(command, [...args], {
      detached: true,
      stdio: "ignore",
    })
    // Must attach before unref: unhandled `error` can exit the host (Bun).
    child.on("error", () => {
      // Best-effort only.
    })
    child.unref()
  } catch {
    // Best-effort: startup must not fail when the opener is unavailable.
  }
}

/** One probe attempt failed (connection refused, non-positive status, etc.). */
class UiNotReady extends Data.TaggedError("UiNotReady")<{
  readonly url: string
}> {}

export type OpenBrowserWhenReadyOptions = {
  /** Override for tests; production uses `globalThis.fetch`. */
  readonly fetch?: (
    input: string,
    init?: RequestInit,
  ) => Promise<Pick<Response, "status" | "body">>
  /** Override for tests; production uses `launchDetachedBrowser`. */
  readonly launch?: (platform: string, url: string) => void
}

/**
 * Poll until the UI URL responds, then launch the platform opener once.
 *
 * Best-effort by construction (`Effect.ignore`): never fails the caller.
 * Interrupt the fiber (e.g. via `Effect.forkScoped` when the scope closes) to
 * stop the poll — including an in-flight fetch when the probe observes the
 * fiber's `AbortSignal`. The browser process itself is not owned or canceled.
 */
export const openBrowserWhenReady = (
  platform: string,
  url: string,
  options: OpenBrowserWhenReadyOptions = {},
): Effect.Effect<void> => {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const launch = options.launch ?? launchDetachedBrowser

  const probeUi = Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal,
      })
      void response.body?.cancel?.()
      if (!(response.status > 0)) {
        throw new Error("UI not ready")
      }
    },
    catch: () => new UiNotReady({ url }),
  })

  return Effect.gen(function* () {
    yield* probeUi.pipe(
      Effect.retry(Schedule.spaced(DEFAULT_POLL_INTERVAL)),
      Effect.timeout(DEFAULT_READY_TIMEOUT),
    )
    // Clock-backed interrupt checkpoint after readiness (same role as the old
    // post-readiness AbortSignal check). Parks on Effect Clock so a closing
    // scope can cancel launch, and tests can assert with TestClock + interrupt.
    yield* Effect.sleep("1 millis")
    yield* Effect.try(() => {
      launch(platform, url)
    }).pipe(Effect.ignore)
  }).pipe(Effect.ignore)
}
