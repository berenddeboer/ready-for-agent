import {
  CARD_COLLAPSE_STORAGE_KEY,
  jobsCardCollapseId,
  readCardCollapsed,
  repositoryCardCollapseId,
  writeCardCollapsed,
} from "../src/card-collapse.js"
import { afterEach, beforeAll, describe, expect, test } from "bun:test"

const memoryStorage = (): Storage => {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.has(key) ? (values.get(key) ?? null) : null
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, String(value))
    },
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  })
})

afterEach(() => {
  localStorage.removeItem(CARD_COLLAPSE_STORAGE_KEY)
})

describe("card collapse preference", () => {
  test("defaults to expanded when unset", () => {
    expect(readCardCollapsed(jobsCardCollapseId())).toBe(false)
    expect(readCardCollapsed(repositoryCardCollapseId("repo-1"))).toBe(false)
  })

  test("persists collapsed state per card id", () => {
    writeCardCollapsed(jobsCardCollapseId(), true)
    writeCardCollapsed(repositoryCardCollapseId("repo-1"), true)
    writeCardCollapsed(repositoryCardCollapseId("repo-2"), false)

    expect(readCardCollapsed(jobsCardCollapseId())).toBe(true)
    expect(readCardCollapsed(repositoryCardCollapseId("repo-1"))).toBe(true)
    expect(readCardCollapsed(repositoryCardCollapseId("repo-2"))).toBe(false)

    const raw = localStorage.getItem(CARD_COLLAPSE_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({
      jobs: true,
      "repository:repo-1": true,
    })
  })

  test("clearing collapse removes the key so default expanded returns", () => {
    writeCardCollapsed(jobsCardCollapseId(), true)
    expect(readCardCollapsed(jobsCardCollapseId())).toBe(true)
    writeCardCollapsed(jobsCardCollapseId(), false)
    expect(readCardCollapsed(jobsCardCollapseId())).toBe(false)
    expect(localStorage.getItem(CARD_COLLAPSE_STORAGE_KEY)).toBe("{}")
  })

  test("ignores corrupt storage", () => {
    localStorage.setItem(CARD_COLLAPSE_STORAGE_KEY, "not-json")
    expect(readCardCollapsed(jobsCardCollapseId())).toBe(false)
    localStorage.setItem(CARD_COLLAPSE_STORAGE_KEY, '["jobs"]')
    expect(readCardCollapsed(jobsCardCollapseId())).toBe(false)
    localStorage.setItem(CARD_COLLAPSE_STORAGE_KEY, '{"jobs":"yes"}')
    expect(readCardCollapsed(jobsCardCollapseId())).toBe(false)
  })

  test("uses stable ids for jobs and repositories", () => {
    expect(jobsCardCollapseId()).toBe("jobs")
    expect(repositoryCardCollapseId("abc")).toBe("repository:abc")
  })
})
