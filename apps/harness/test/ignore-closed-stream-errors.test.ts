import { isBenignClosedStreamError } from "../src/server/ignore-closed-stream-errors.js"
import { expect, test } from "bun:test"

test("recognizes the undici closed-stream teardown race", () => {
  const error = new TypeError("Invalid state: ReadableStream is already closed")
  ;(error as { code?: string }).code = "ERR_INVALID_STATE"
  error.stack = `${error.name}: ${error.message}
    at ReadableByteStreamController.close (node:internal/webstreams/readablestream:1190:13)
    at node:internal/deps/undici/undici:1965:30`

  expect(isBenignClosedStreamError(error)).toBe(true)
})

test("does not swallow unrelated invalid-state errors", () => {
  const locked = new TypeError("Invalid state: ReadableStream is locked")
  ;(locked as { code?: string }).code = "ERR_INVALID_STATE"

  expect(isBenignClosedStreamError(locked)).toBe(false)
  expect(isBenignClosedStreamError(new Error("boom"))).toBe(false)

  const applicationError = new TypeError(
    "Invalid state: ReadableStream is already closed",
  )
  ;(applicationError as { code?: string }).code = "ERR_INVALID_STATE"
  applicationError.stack = `${applicationError.name}: ${applicationError.message}
    at closeApplicationStream (/app/server.ts:42:11)`
  expect(isBenignClosedStreamError(applicationError)).toBe(false)
})
