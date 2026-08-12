import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

const GITHUB_THROTTLED = "GITHUB_THROTTLED"

type GenqlErrorLike = Error & {
  readonly errors: ReadonlyArray<{
    readonly extensions?: Record<string, unknown>
  }>
}

const isGenqlErrorLike = (error: unknown): error is GenqlErrorLike =>
  error instanceof Error &&
  "errors" in error &&
  Array.isArray((error as { errors: unknown }).errors)

const isoFromRetryAt = (retryAt: unknown): string | null => {
  if (typeof retryAt === "number" && Number.isFinite(retryAt)) {
    const parsed = new Date(retryAt)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (typeof retryAt === "string" && retryAt.length > 0) {
    const parsed = new Date(retryAt)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

/** Future ISO-8601 `retryAt` from a Genql-shaped `GITHUB_THROTTLED` error. */
export const githubThrottledRetryAtFromError = (
  error: unknown,
  nowMs: number = Date.now(),
): string | null => {
  if (!isGenqlErrorLike(error)) return null
  let latest: string | null = null
  for (const graphQlError of error.errors) {
    if (graphQlError.extensions?.code !== GITHUB_THROTTLED) continue
    const iso = isoFromRetryAt(graphQlError.extensions.retryAt)
    if (iso === null) continue
    const retryAtMs = Date.parse(iso)
    if (Number.isNaN(retryAtMs) || retryAtMs <= nowMs) continue
    latest = laterGithubThrottleDeadline(latest, iso)
  }
  return latest
}

/** Keep the later ISO deadline; nulls do not replace a known deadline. */
export const laterGithubThrottleDeadline = (
  current: string | null,
  candidate: string | null,
): string | null => {
  if (candidate === null) return current
  if (current === null) return candidate
  const currentMs = Date.parse(current)
  const candidateMs = Date.parse(candidate)
  if (Number.isNaN(candidateMs)) return current
  if (Number.isNaN(currentMs)) return candidate
  return candidateMs > currentMs ? candidate : current
}

const defaultScheduleHide = (
  callback: () => void,
  delayMs: number,
): (() => void) => {
  const handle = setTimeout(callback, delayMs)
  return () => {
    clearTimeout(handle)
  }
}

/**
 * Drive the GitHub Throttle banner from TanStack Query / mutation cache
 * errors. Clears locally when `retryAt` elapses — no network.
 */
export const followGithubThrottleErrors = ({
  queryClient,
  onRetryAtChange,
  now = Date.now,
  scheduleHide = defaultScheduleHide,
}: {
  readonly queryClient: QueryClient
  readonly onRetryAtChange: (retryAt: string | null) => void
  readonly now?: () => number
  readonly scheduleHide?: (callback: () => void, delayMs: number) => () => void
}): (() => void) => {
  let retryAt: string | null = null
  let cancelHide: (() => void) | undefined

  const publish = (next: string | null) => {
    if (next === retryAt) return
    retryAt = next
    cancelHide?.()
    cancelHide = undefined
    if (next !== null) {
      const delayMs = Date.parse(next) - now()
      if (delayMs <= 0) {
        retryAt = null
      } else {
        const scheduled = next
        cancelHide = scheduleHide(() => {
          if (retryAt !== scheduled) return
          retryAt = null
          cancelHide = undefined
          onRetryAtChange(null)
        }, delayMs)
      }
    }
    onRetryAtChange(retryAt)
  }

  const considerError = (error: unknown) => {
    publish(
      laterGithubThrottleDeadline(
        retryAt,
        githubThrottledRetryAtFromError(error, now()),
      ),
    )
  }

  const unsubscribeQuery = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return
    considerError(event.query.state.error)
  })
  const unsubscribeMutation = queryClient
    .getMutationCache()
    .subscribe((event) => {
      if (event.type !== "updated") return
      considerError(event.mutation.state.error)
    })

  for (const query of queryClient.getQueryCache().getAll()) {
    considerError(query.state.error)
  }
  for (const mutation of queryClient.getMutationCache().getAll()) {
    considerError(mutation.state.error)
  }

  return () => {
    unsubscribeQuery()
    unsubscribeMutation()
    cancelHide?.()
  }
}

/** Always-mounted banner deadline from GraphQL `GITHUB_THROTTLED` errors. */
export const useGithubThrottleRetryAt = (): string | null => {
  const queryClient = useQueryClient()
  const [retryAt, setRetryAt] = useState<string | null>(null)
  useEffect(
    () =>
      followGithubThrottleErrors({
        queryClient,
        onRetryAtChange: setRetryAt,
      }),
    [queryClient],
  )
  return retryAt
}
