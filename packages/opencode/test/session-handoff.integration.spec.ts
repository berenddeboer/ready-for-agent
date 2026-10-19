/**
 * Real OpenCode 2.0.32 pairing contract. Isolated servers only: private
 * XDG dirs, `opencode serve` without `--service`, so the operator's shared
 * service and registration are not touched.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverOpenCodeHandoffEndpoint } from "../src/lib/opencode-v2-client.js"
import { openCodeBasicAuthHeaders } from "../src/lib/owned-server.js"
import {
  mintOpenCodeSessionHandoff,
  selectOpenCodeHandoffServer,
} from "../src/lib/session-handoff.js"
import { openCodeSessionWebUrl } from "../src/lib/session-web-url.js"
import { describe, expect, it } from "bun:test"

const passwordFor = () => `handoff-${crypto.randomUUID()}`

const reservePort = async (): Promise<number> => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      open(socket) {
        socket.end()
      },
    },
  })
  const port = server.port
  server.stop(true)
  return port
}

const startServer = async (input: {
  readonly label: string
  readonly password: string
}): Promise<{
  readonly baseUrl: string
  readonly password: string
  readonly pid: number
  readonly stop: () => Promise<void>
}> => {
  const root = mkdtempSync(join(tmpdir(), `opencode-handoff-${input.label}-`))
  const port = await reservePort()
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_SERVER_PASSWORD: input.password,
  }
  for (const dir of [
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    join(root, "proj"),
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  const proc = Bun.spawn({
    cmd: [
      "opencode",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    cwd: join(root, "proj"),
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const baseUrl = `http://127.0.0.1:${String(port)}`
  const headers = openCodeBasicAuthHeaders(input.password)
  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/info`, { headers })
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // still starting
    }
    await Bun.sleep(200)
  }
  if (!ready) {
    proc.kill()
    throw new Error(`${input.label} OpenCode server did not become ready`)
  }
  return {
    baseUrl,
    password: input.password,
    pid: proc.pid,
    stop: async () => {
      proc.kill()
      await proc.exited
    },
  }
}

const createSession = async (input: {
  readonly baseUrl: string
  readonly password: string
  readonly title: string
}): Promise<string> => {
  const response = await fetch(`${input.baseUrl}/api/session`, {
    method: "POST",
    headers: {
      ...openCodeBasicAuthHeaders(input.password),
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: input.title }),
  })
  expect(response.ok).toBe(true)
  const body = (await response.json()) as { data?: { id?: string } }
  const id = body.data?.id
  expect(id?.startsWith("ses_")).toBe(true)
  return id ?? ""
}

describe("OpenCode session handoff against an isolated V2 server", () => {
  it("pairs the selected server and the cookie reaches that session, not a decoy", async () => {
    const target = await startServer({
      label: "target",
      password: passwordFor(),
    })
    const decoy = await startServer({
      label: "decoy",
      password: passwordFor(),
    })
    try {
      const sessionId = await createSession({
        baseUrl: target.baseUrl,
        password: target.password,
        title: "handoff fixture",
      })
      const decoyHits = { count: 0 }
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.startsWith(decoy.baseUrl)) decoyHits.count += 1
        return originalFetch(input, init)
      }
      try {
        const selected = selectOpenCodeHandoffServer({
          connection: {
            kind: "dedicated",
            baseUrl: target.baseUrl,
            headers: openCodeBasicAuthHeaders(target.password),
          },
          discovered: {
            baseUrl: decoy.baseUrl,
            headers: openCodeBasicAuthHeaders(decoy.password),
          },
        })
        const handoff = await mintOpenCodeSessionHandoff({
          server: selected,
          sessionId,
        })
        expect(handoff.kind).toBe("ready")
        if (handoff.kind !== "ready") return
        expect(handoff.launch.connectUrl.startsWith(target.baseUrl)).toBe(true)
        expect(handoff.launch.sessionUrl).toBe(
          openCodeSessionWebUrl({ serverBase: target.baseUrl, sessionId }),
        )
        expect(handoff.launch.connectUrl).not.toContain(target.password)
        expect(JSON.stringify(handoff)).not.toContain(decoy.password)

        const redeemed = await originalFetch(handoff.launch.connectUrl, {
          headers: { accept: "text/html" },
          redirect: "manual",
        })
        expect(redeemed.status).toBe(302)
        expect(redeemed.headers.get("location")).toBe("/")
        const cookie = redeemed.headers.get("set-cookie") ?? ""
        expect(cookie).toContain("opencode_session_")
        expect(cookie.toLowerCase()).toContain("httponly")
        const cookiePair = cookie.split(";", 1)[0] ?? ""
        const session = await originalFetch(
          `${target.baseUrl}/api/session/${sessionId}`,
          { headers: { cookie: cookiePair } },
        )
        expect(session.status).toBe(200)
        const sessionBody = (await session.json()) as {
          data?: { id?: string; title?: string }
        }
        expect(sessionBody.data?.id).toBe(sessionId)
        expect(sessionBody.data?.title).toBe("handoff fixture")

        const reused = await originalFetch(handoff.launch.connectUrl, {
          headers: { accept: "text/html" },
          redirect: "manual",
        })
        expect(reused.status).toBe(401)
        expect(decoyHits.count).toBe(0)
      } finally {
        globalThis.fetch = originalFetch
      }
    } finally {
      await target.stop()
      await decoy.stop()
    }
  })

  it("discovers an isolated registration and does not use a different server", async () => {
    const target = await startServer({
      label: "shared",
      password: passwordFor(),
    })
    const decoy = await startServer({
      label: "other",
      password: passwordFor(),
    })
    try {
      const info = await fetch(`${target.baseUrl}/api/info`, {
        headers: openCodeBasicAuthHeaders(target.password),
      })
      const serverInfo = (await info.json()) as { pid: number; version: string }
      const file = join(
        tmpdir(),
        `opencode-service-${crypto.randomUUID()}.json`,
      )
      writeFileSync(
        file,
        JSON.stringify({
          id: "isolated-handoff",
          version: serverInfo.version,
          url: target.baseUrl,
          pid: serverInfo.pid,
          password: target.password,
        }),
      )
      const discovered = await discoverOpenCodeHandoffEndpoint({ file })
      expect(discovered?.baseUrl).toBe(target.baseUrl)
      expect(JSON.stringify(discovered)).not.toContain(decoy.password)
      const selected = selectOpenCodeHandoffServer({
        connection: { kind: "default" },
        discovered,
      })
      expect(selected).toMatchObject({
        kind: "server",
        baseUrl: target.baseUrl,
        mode: "shared",
      })
    } finally {
      await target.stop()
      await decoy.stop()
    }
  })
})
