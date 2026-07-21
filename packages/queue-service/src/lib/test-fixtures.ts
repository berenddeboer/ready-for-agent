import { Effect } from "effect"
import type { QueueServiceShape } from "./queue-service.js"

const unexpected = (operation: keyof QueueServiceShape) =>
  Effect.die(`Unexpected QueueService.${operation} call`)

export const stubQueueService = (
  overrides: Partial<QueueServiceShape> = {},
): QueueServiceShape => ({
  queueInTransaction: true,
  enqueue: () => unexpected("enqueue"),
  enqueueWithDelay: () => unexpected("enqueueWithDelay"),
  ensureKeyed: () => unexpected("ensureKeyed"),
  listKeyed: () => unexpected("listKeyed"),
  reviveExhaustedKeyed: () => unexpected("reviveExhaustedKeyed"),
  postponeKeyed: () => unexpected("postponeKeyed"),
  removeKeyed: () => unexpected("removeKeyed"),
  rawClaim: () => unexpected("rawClaim"),
  acknowledge: () => unexpected("acknowledge"),
  fail: () => unexpected("fail"),
  extendVisibility: () => unexpected("extendVisibility"),
  getStats: () => unexpected("getStats"),
  requeueByPayloadTag: () => unexpected("requeueByPayloadTag"),
  ...overrides,
})
