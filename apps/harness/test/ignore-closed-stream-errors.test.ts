import {
  isBenignClosedStreamError,
  isBenignRequestAbortError,
} from "../src/server/ignore-closed-stream-errors.js"
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

test("recognizes srvx client-disconnect AbortError", () => {
  const cause = new DOMException("This operation was aborted", "AbortError")
  cause.stack = `${cause.name}: ${cause.message}
    at abort (file:///.../srvx/dist/adapters/node.mjs:292:51)
    at ServerResponse.<anonymous> (file:///.../srvx/dist/adapters/node.mjs:296:35)`
  const error = new Error("This operation was aborted", { cause })
  error.name = "AbortError"
  error.stack = `${error.name}: ${error.message}
    at abort (file:///.../srvx/dist/adapters/node.mjs:292:51)
    at ServerResponse.<anonymous> (file:///.../srvx/dist/adapters/node.mjs:296:35)`

  expect(isBenignRequestAbortError(error)).toBe(true)
  expect(isBenignRequestAbortError(cause)).toBe(true)
})

test("recognizes h3 unhandled wrapper around AbortError", () => {
  const cause = new DOMException("This operation was aborted", "AbortError")
  cause.stack = `${cause.name}: ${cause.message}
    at abort (file:///.../srvx/dist/adapters/node.mjs:292:51)`
  const wrapped = Object.assign(
    new Error("This operation was aborted", { cause }),
    {
      status: 500,
      unhandled: true,
    },
  )

  expect(isBenignRequestAbortError(wrapped)).toBe(true)
})

test("does not swallow application AbortErrors without disconnect markers", () => {
  const generic = new DOMException("This operation was aborted", "AbortError")
  expect(isBenignRequestAbortError(generic)).toBe(false)

  const intentional = new Error("user cancelled checkout")
  intentional.name = "AbortError"
  expect(isBenignRequestAbortError(intentional)).toBe(false)

  const applicationAbort = Object.assign(
    new Error("request failed", { cause: generic }),
    { unhandled: true },
  )
  expect(isBenignRequestAbortError(applicationAbort)).toBe(false)

  const wrapped = Object.assign(
    new Error("failed", { cause: new Error("boom") }),
    {
      unhandled: true,
    },
  )
  expect(isBenignRequestAbortError(wrapped)).toBe(false)
})
