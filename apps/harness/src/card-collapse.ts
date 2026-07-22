import { useCallback, useEffect, useState } from "react"

export const CARD_COLLAPSE_STORAGE_KEY = "ready-for-agent.card-collapsed"

const browserStorage = (): Storage | null => {
  try {
    const storage = globalThis.localStorage
    return storage ?? null
  } catch {
    return null
  }
}

const readStore = (): Record<string, boolean> => {
  const storage = browserStorage()
  if (storage === null) return {}
  try {
    const raw = storage.getItem(CARD_COLLAPSE_STORAGE_KEY)
    if (raw === null || raw === "") return {}
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    const store: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") store[key] = value
    }
    return store
  } catch {
    return {}
  }
}

/** Whether a card is collapsed; missing keys default to expanded. */
export function readCardCollapsed(cardId: string): boolean {
  return readStore()[cardId] === true
}

/** Persist collapsed/expanded for one card id. */
export function writeCardCollapsed(cardId: string, collapsed: boolean): void {
  const storage = browserStorage()
  if (storage === null) return
  try {
    const store = readStore()
    if (collapsed) store[cardId] = true
    else delete store[cardId]
    storage.setItem(CARD_COLLAPSE_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Quota or private mode — preference is best-effort only.
  }
}

export function jobsCardCollapseId(): string {
  return "jobs"
}

export function repositoryCardCollapseId(repositoryId: string): string {
  return `repository:${repositoryId}`
}

/** Collapsed preference for a dashboard card, restored from localStorage. */
export function useCardCollapsed(cardId: string): {
  collapsed: boolean
  setCollapsed: (collapsed: boolean) => void
  toggleCollapsed: () => void
} {
  const [collapsed, setCollapsedState] = useState(false)

  useEffect(() => {
    setCollapsedState(readCardCollapsed(cardId))
  }, [cardId])

  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next)
      writeCardCollapsed(cardId, next)
    },
    [cardId],
  )

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((current) => {
      const next = !current
      writeCardCollapsed(cardId, next)
      return next
    })
  }, [cardId])

  return { collapsed, setCollapsed, toggleCollapsed }
}
