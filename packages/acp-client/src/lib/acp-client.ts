import { type ChildProcess, spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import {
  type AcpClientError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSpawnError,
} from "./errors.js"
import type {
  AcpAuthenticateInput,
  AcpCancelInput,
  AcpConnectInput,
  AcpConnection,
  AcpInitializeInput,
  AcpInitializeResult,
  AcpLoadSessionInput,
  AcpMeta,
  AcpNewSessionInput,
  AcpPromptInput,
  AcpPromptResult,
  AcpResumeSessionInput,
  AcpSessionResult,
} from "./types.js"
import { AcpSessionId, AcpStopReason } from "./types.js"

export type AcpClientShape = {
  readonly connect: (
    input: AcpConnectInput,
  ) => Effect.Effect<AcpConnection, AcpClientError, Scope.Scope>
}

const requestMeta = (
  meta: AcpMeta | undefined,
): { readonly _meta?: AcpMeta } => (meta === undefined ? {} : { _meta: meta })

const responseMeta = (
  meta: { readonly [key: string]: unknown } | null | undefined,
): { readonly _meta?: AcpMeta } => (meta == null ? {} : { _meta: meta })

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error

const toSpawnError = (command: string, cause: unknown): AcpSpawnError =>
  new AcpSpawnError({
    command,
    message:
      isErrnoException(cause) && cause.code === "ENOENT"
        ? `Agent command not found: ${command}`
        : "Failed to spawn ACP agent",
    cause,
  })

const waitForSpawn = (
  child: ChildProcess,
  command: string,
): Effect.Effect<void, AcpSpawnError> =>
  Effect.callback<void, AcpSpawnError>((resume) => {
    const onError = (error: Error) => {
      child.off("spawn", onSpawn)
      resume(Effect.fail(toSpawnError(command, error)))
    }
    const onSpawn = () => {
      child.off("error", onError)
      resume(Effect.void)
    }
    child.once("error", onError)
    child.once("spawn", onSpawn)
    return Effect.sync(() => {
      child.off("error", onError)
      child.off("spawn", onSpawn)
    })
  })

type SessionBuffers = {
  readonly collecting: Set<string>
  readonly chunks: Map<string, string[]>
}

const attachConnection = (
  sdk: acp.ClientConnection,
  command: string,
  exit: { code?: number | null },
  buffers: SessionBuffers,
): AcpConnection => {
  const takeText = (sessionId: string): string => {
    const text = (buffers.chunks.get(sessionId) ?? []).join("")
    buffers.chunks.delete(sessionId)
    return text
  }

  const toRequestError = (method: string) => (cause: unknown) => {
    if (exit.code !== undefined) {
      return new AcpProcessExitError({
        command,
        exitCode: exit.code,
        message: `ACP agent exited before ${method} completed`,
      })
    }
    return new AcpProtocolError({
      method,
      message: cause instanceof Error ? cause.message : "ACP request failed",
      cause,
    })
  }

  const request = <A>(
    method: string,
    run: () => Promise<A>,
  ): Effect.Effect<A, AcpClientError> =>
    Effect.tryPromise({
      try: run,
      catch: toRequestError(method),
    })

  const initialize = Effect.fn("AcpConnection.initialize")(function* (
    input: AcpInitializeInput = {},
  ) {
    const result = yield* request("initialize", () =>
      sdk.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {
          name: "ready-for-agent",
          version: "0.0.1",
        },
        ...requestMeta(input._meta),
      }),
    )
    const initialized: AcpInitializeResult = {
      protocolVersion: result.protocolVersion,
      loadSession: result.agentCapabilities?.loadSession === true,
      resume: result.agentCapabilities?.sessionCapabilities?.resume != null,
      authMethods: (result.authMethods ?? []).map((method) => ({
        id: method.id,
        name: method.name,
      })),
      ...responseMeta(result._meta),
    }
    return initialized
  })

  const authenticate = Effect.fn("AcpConnection.authenticate")(function* (
    input: AcpAuthenticateInput,
  ) {
    yield* request("authenticate", () =>
      sdk.agent.request(acp.methods.agent.authenticate, {
        methodId: input.methodId,
        ...requestMeta(input._meta),
      }),
    )
  })

  const toSessionResult = (
    sessionId: string,
    meta: { readonly [key: string]: unknown } | null | undefined,
  ): AcpSessionResult => ({
    sessionId: AcpSessionId.make(sessionId),
    ...responseMeta(meta),
  })

  const newSession = Effect.fn("AcpConnection.newSession")(function* (
    input: AcpNewSessionInput,
  ) {
    const result = yield* request("session/new", () =>
      sdk.agent.request(acp.methods.agent.session.new, {
        cwd: input.cwd,
        mcpServers: [],
        ...requestMeta(input._meta),
      }),
    )
    return toSessionResult(result.sessionId, result._meta)
  })

  const loadSession = Effect.fn("AcpConnection.loadSession")(function* (
    input: AcpLoadSessionInput,
  ) {
    const result = yield* request("session/load", () =>
      sdk.agent.request(acp.methods.agent.session.load, {
        sessionId: input.sessionId,
        cwd: input.cwd,
        mcpServers: [],
        ...requestMeta(input._meta),
      }),
    )
    return toSessionResult(input.sessionId, result._meta)
  })

  const resumeSession = Effect.fn("AcpConnection.resumeSession")(function* (
    input: AcpResumeSessionInput,
  ) {
    const result = yield* request("session/resume", () =>
      sdk.agent.request(acp.methods.agent.session.resume, {
        sessionId: input.sessionId,
        cwd: input.cwd,
        mcpServers: [],
        ...requestMeta(input._meta),
      }),
    )
    return toSessionResult(input.sessionId, result._meta)
  })

  const prompt = Effect.fn("AcpConnection.prompt")(function* (
    input: AcpPromptInput,
  ) {
    buffers.collecting.add(input.sessionId)
    buffers.chunks.delete(input.sessionId)
    const result = yield* request("session/prompt", () =>
      sdk.agent.request(acp.methods.agent.session.prompt, {
        sessionId: input.sessionId,
        prompt: [{ type: "text", text: input.prompt }],
        ...requestMeta(input._meta),
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          buffers.collecting.delete(input.sessionId)
        }),
      ),
    )
    const stopReason = yield* Schema.decodeUnknownEffect(AcpStopReason)(
      result.stopReason,
    ).pipe(
      Effect.mapError(
        () =>
          new AcpProtocolError({
            method: "session/prompt",
            message: "Unknown stop reason",
          }),
      ),
    )
    const completed: AcpPromptResult = {
      sessionId: input.sessionId,
      assistantText: takeText(input.sessionId),
      stopReason,
      ...responseMeta(result._meta),
    }
    return completed
  })

  const cancel = Effect.fn("AcpConnection.cancel")(function* (
    input: AcpCancelInput,
  ) {
    yield* request("session/cancel", () =>
      sdk.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: input.sessionId,
        ...requestMeta(input._meta),
      }),
    )
  })

  return {
    initialize,
    authenticate,
    newSession,
    loadSession,
    resumeSession,
    prompt,
    cancel,
  }
}

const connect = Effect.fn("AcpClient.connect")(function* (
  input: AcpConnectInput,
) {
  const args = input.args === undefined ? [] : [...input.args]
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        spawn(input.command, args, {
          cwd: input.cwd,
          env: input.env === undefined ? process.env : { ...input.env },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      catch: (cause) => toSpawnError(input.command, cause),
    }),
    (process) =>
      Effect.sync(() => {
        if (!process.killed) {
          process.kill("SIGTERM")
        }
      }),
  )

  yield* waitForSpawn(child, input.command)

  const stdin = child.stdin
  const stdout = child.stdout
  if (stdin === null || stdout === null) {
    return yield* new AcpSpawnError({
      command: input.command,
      message: "ACP agent stdio pipes are unavailable",
    })
  }

  child.stderr?.resume()
  const exit: { code?: number | null } = {}
  child.once("exit", (code) => {
    exit.code = code
  })

  const buffers: SessionBuffers = {
    collecting: new Set<string>(),
    chunks: new Map<string, string[]>(),
  }
  const collectSessionUpdate = (notification: acp.SessionNotification) => {
    if (!buffers.collecting.has(notification.sessionId)) {
      return
    }
    const update = notification.update
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      const existing = buffers.chunks.get(notification.sessionId) ?? []
      existing.push(update.content.text)
      buffers.chunks.set(notification.sessionId, existing)
    }
  }

  const sdk = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const stream = acp.ndJsonStream(
          Writable.toWeb(stdin),
          Readable.toWeb(stdout),
        )
        return acp
          .client({ name: "ready-for-agent" })
          .onNotification(acp.methods.client.session.update, (ctx) => {
            collectSessionUpdate(ctx.params)
          })
          .connect(stream)
      },
      catch: (cause) =>
        new AcpProtocolError({
          method: "connect",
          message: "Failed to open ACP connection",
          cause,
        }),
    }),
    (connection) => Effect.sync(() => connection.close()),
  )

  return attachConnection(sdk, input.command, exit, buffers)
})

export class AcpClient extends Context.Service<AcpClient, AcpClientShape>()(
  "@ready-for-agent/acp-client/AcpClient",
) {
  static readonly layer = Layer.succeed(AcpClient, { connect })
}
