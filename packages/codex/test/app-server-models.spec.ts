import {
  encodeAppServerNotification,
  encodeAppServerRequest,
  parseAppServerLine,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("app-server JSONL framing", () => {
  it("encodes initialize and model/list without a jsonrpc member", () => {
    const initialize = encodeAppServerRequest({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "ready_for_agent",
          title: "Ready for Agent",
          version: "0",
        },
      },
    })
    const list = encodeAppServerRequest({
      id: 2,
      method: "model/list",
      params: { includeHidden: false },
    })
    const initialized = encodeAppServerNotification({ method: "initialized" })

    expect(initialize.endsWith("\n")).toBe(true)
    expect(JSON.parse(initialize)).toEqual({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "ready_for_agent",
          title: "Ready for Agent",
          version: "0",
        },
      },
    })
    expect(JSON.parse(list)).toEqual({
      method: "model/list",
      id: 2,
      params: { includeHidden: false },
    })
    expect(JSON.parse(initialized)).toEqual({ method: "initialized" })
    expect("jsonrpc" in JSON.parse(initialize)).toBe(false)
  })

  it("matches responses by id and keeps RPC errors and notifications distinct", () => {
    expect(
      parseAppServerLine(
        '{"id":2,"result":{"data":[{"model":"gpt-6-astra"}],"nextCursor":null}}',
      ),
    ).toEqual({
      kind: "response",
      id: "2",
      result: { data: [{ model: "gpt-6-astra" }], nextCursor: null },
    })
    expect(
      parseAppServerLine(
        '{"id":2,"error":{"code":-32600,"message":"invalid cursor: invalid"}}',
      ),
    ).toEqual({
      kind: "error",
      id: "2",
      code: -32600,
      message: "invalid cursor: invalid",
    })
    expect(parseAppServerLine('{"method":"server/ready"}')).toEqual({
      kind: "notification",
      method: "server/ready",
    })
    expect(parseAppServerLine("not-json")).toEqual({
      kind: "malformed",
      reason: "line is not JSON",
    })
  })
})
