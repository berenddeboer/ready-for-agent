import type { ChildProcess } from "node:child_process"
import { Effect } from "effect"
import {
  AGENT_BACKEND_EXIT_MESSAGE_MAX,
  STDERR_TAIL_LIMIT,
  sanitizeAgentBackendStderrTail,
} from "@ready-for-agent/agent-backend"

/** Bound so a child that keeps the stderr write end open cannot stall exit. */
const STDERR_DRAIN_TIMEOUT_MS = 500

const appendStderrTail = (tail: string, chunk: string): string => {
  const combined = `${tail}${chunk}`
  return combined.length <= STDERR_TAIL_LIMIT
    ? combined
    : `…${combined.slice(-(STDERR_TAIL_LIMIT - 1))}`
}

export type ChildStderrCapture = {
  readonly text: () => string
  /** Completes when stderr ends, or after a short timeout if it stays open. */
  readonly drained: Effect.Effect<void>
}

/**
 * Fold stderr to the shared tail bound while the process runs.
 *
 * The listener is attached before the caller yields so a chatty child cannot
 * fill the pipe and block. `resume()` without a listener would discard this
 * output.
 */
export const captureChildStderr = (child: ChildProcess): ChildStderrCapture => {
  const stderr = child.stderr
  if (stderr == null) {
    return { text: () => "", drained: Effect.void }
  }

  let tail = ""
  stderr.setEncoding("utf8")
  stderr.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    tail = appendStderrTail(tail, text)
  })
  // A closed pipe during cleanup must not become an unhandled error.
  stderr.on("error", () => {})
  stderr.resume()

  const drained = Effect.callback<void>((resume) => {
    if (stderr.readableEnded || stderr.destroyed) {
      resume(Effect.void)
      return Effect.void
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      resume(Effect.void)
    }

    // `exit` can be observed before the last stderr chunk is delivered.
    stderr.once("end", finish)
    stderr.once("close", finish)
    stderr.once("error", finish)
    if (stderr.readableEnded || stderr.destroyed) {
      finish()
      return Effect.void
    }

    timer = setTimeout(finish, STDERR_DRAIN_TIMEOUT_MS)
    timer.unref?.()
    return Effect.sync(() => {
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      stderr.off("end", finish)
      stderr.off("close", finish)
      stderr.off("error", finish)
    })
  })

  return {
    text: () => tail,
    drained,
  }
}

const fallbackMessage = (method: string): string =>
  `ACP agent exited before ${method} completed`

/**
 * Operator-facing process-exit text.
 *
 * Empty stderr keeps the method-specific fallback. Otherwise the message
 * keeps the method, command, and exit code when they fit with the sanitized
 * tail. A tail that would push past the operator cap drops the command path
 * from the text and keeps the end of the diagnostic; `command` stays on the
 * error either way.
 */
export const formatAcpProcessExitMessage = (input: {
  readonly method: string
  readonly command: string
  readonly exitCode: number | null
  readonly stderr: string
}): string => {
  const fallback = fallbackMessage(input.method)
  const raw = input.stderr.trim()
  if (raw.length === 0) {
    return fallback
  }

  const exitLabel = input.exitCode === null ? "null" : String(input.exitCode)
  const commandHeader = `${fallback} (${input.command}, exit ${exitLabel}): `
  const exitHeader = `${fallback} (exit ${exitLabel}): `
  const fullTail = sanitizeAgentBackendStderrTail(raw)
  if (fullTail === undefined) {
    return fallback
  }
  if (
    commandHeader.length + fullTail.length <=
    AGENT_BACKEND_EXIT_MESSAGE_MAX
  ) {
    return `${commandHeader}${fullTail}`
  }

  const budget = AGENT_BACKEND_EXIT_MESSAGE_MAX - exitHeader.length
  if (budget <= 0) {
    return fallback
  }
  const tail = sanitizeAgentBackendStderrTail(raw, budget)
  if (tail === undefined) {
    return fallback
  }
  return `${exitHeader}${tail}`
}
