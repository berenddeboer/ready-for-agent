import {
  completedPageSearch,
  parseCompletedSearch,
} from "../src/completed-search.js"
import { describe, expect, test } from "bun:test"

describe("Completed route search", () => {
  test.each([
    [{}, { page: undefined }],
    [{ page: undefined }, { page: undefined }],
    [{ page: "invalid" }, { page: undefined }],
    [{ page: 1.5 }, { page: undefined }],
    [{ page: "1.5" }, { page: undefined }],
    [{ page: 0 }, { page: undefined }],
    [{ page: -1 }, { page: undefined }],
  ] as const)(
    "defaults invalid or absent page search to page 1",
    (raw, expected) => {
      expect(parseCompletedSearch(raw)).toEqual(expected)
    },
  )

  test.each([
    [{ page: 2 }, { page: 2 }],
    [{ page: "2" }, { page: 2 }],
  ] as const)("accepts a positive integer page", (raw, expected) => {
    expect(parseCompletedSearch(raw)).toEqual(expected)
  })

  test("uses the bare /completed search for page 1", () => {
    expect(completedPageSearch(1)).toEqual({})
    expect(completedPageSearch(2)).toEqual({ page: 2 })
  })
})
