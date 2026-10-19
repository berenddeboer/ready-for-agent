import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withOpenCodeServer } from "../src/lib/build-args.js"
import {
  type OwnedOpenCodeServer,
  startOwnedOpenCodeServer,
} from "../src/lib/owned-server.js"
import { describe, expect, it } from "bun:test"

const opencode = Bun.which("opencode")
const probeUrl = "http://127.0.0.1:9/ber33-owned-probe/mcp"

const assertSecretAbsent = (text: string, secret: string, label: string) => {
  if (secret.length > 0 && text.includes(secret)) {
    throw new Error(`${label} exposed a secret`)
  }
}

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("no port"))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve(port)
      })
    })
  })

const readServiceStatus = async (): Promise<string | undefined> => {
  const proc = Bun.spawn(["opencode", "service", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const timer = setTimeout(() => {
    proc.kill()
  }, 3_000)
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (code !== 0) return undefined
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(
        (entry) => entry.startsWith("http://") || entry.startsWith("https://"),
      )
    return line
  } finally {
    clearTimeout(timer)
  }
}

const stop = async (proc: Bun.Subprocess) => {
  if (proc.exitCode !== null) return
  proc.kill("SIGTERM")
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 3_000)
    }),
  ])
  if (!exited) {
    proc.kill("SIGKILL")
    await proc.exited
  }
}

const waitForHttp = async (
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> => {
  const deadline = Date.now() + 12_000
  for (;;) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {
      // still starting
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${url}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe.skipIf(opencode === null)(
  "harness-owned OpenCode server boundary",
  () => {
    it("injects Keymaxxer into the owned server and not into an already-running server", async () => {
      const sharedBefore = await readServiceStatus()
      const standInPort = await reservePort()
      const standInPassword = "stand-in-password"
      const standIn = Bun.spawn({
        cmd: [
          "opencode",
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(standInPort),
        ],
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: standInPassword,
          OPENCODE_CONFIG_CONTENT: "{}",
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      let owned: OwnedOpenCodeServer | undefined
      try {
        await waitForHttp(
          `http://127.0.0.1:${String(standInPort)}/api/config`,
          {
            authorization: `Basic ${Buffer.from(`opencode:${standInPassword}`).toString("base64")}`,
          },
        )
        owned = await startOwnedOpenCodeServer({
          keymaxxerMcpUrl: probeUrl,
          readyTimeoutMs: 15_000,
        })
        expect(owned.baseUrl).not.toBe(
          `http://127.0.0.1:${String(standInPort)}`,
        )
        expect(owned.baseUrl).not.toBe(sharedBefore)

        const ownedConfig = await fetch(`${owned.baseUrl}/api/config`, {
          headers: owned.headers,
        })
        expect(ownedConfig.status).toBe(200)
        const ownedBody = await ownedConfig.text()
        expect(ownedBody).toContain(probeUrl)
        expect(ownedBody).toContain('"type":"remote"')
        expect(ownedBody).toContain('"disabled":false')

        const cli = Bun.spawn({
          cmd: [
            "opencode",
            ...withOpenCodeServer(["api", "get", "/api/config"], owned.baseUrl),
          ],
          env: {
            ...process.env,
            OPENCODE_PASSWORD: owned.password,
          },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        })
        const [cliStdout, cliStderr, cliCode] = await Promise.all([
          new Response(cli.stdout).text(),
          new Response(cli.stderr).text(),
          cli.exited,
        ])
        expect(cliCode).toBe(0)
        expect(cliStdout).toContain(probeUrl)
        assertSecretAbsent(cliStderr, owned.password, "owned cli stderr")
        assertSecretAbsent(cliStderr, probeUrl, "owned cli stderr")

        const standInConfig = await fetch(
          `http://127.0.0.1:${String(standInPort)}/api/config`,
          {
            headers: {
              authorization: `Basic ${Buffer.from(`opencode:${standInPassword}`).toString("base64")}`,
            },
          },
        )
        expect(standInConfig.status).toBe(200)
        expect(await standInConfig.text()).not.toContain(probeUrl)

        if (sharedBefore !== undefined) {
          const sharedEnv = { ...process.env }
          delete sharedEnv.OPENCODE_PASSWORD
          delete sharedEnv.OPENCODE_SERVER_PASSWORD
          const sharedCli = Bun.spawn(
            ["opencode", "api", "get", "/api/config"],
            {
              env: sharedEnv,
              stdout: "pipe",
              stderr: "pipe",
              stdin: "ignore",
            },
          )
          const [sharedStdout, sharedCode] = await Promise.all([
            new Response(sharedCli.stdout).text(),
            sharedCli.exited,
          ])
          expect(sharedCode).toBe(0)
          expect(sharedStdout).not.toContain(probeUrl)
          expect(await readServiceStatus()).toBe(sharedBefore)
        }

        const ownedPid = owned.pid
        const ownedUrl = owned.baseUrl
        await owned.dispose()
        owned = undefined
        await expect(
          fetch(ownedUrl, { signal: AbortSignal.timeout(1_000) }),
        ).rejects.toThrow()
        expect(
          Bun.spawnSync(["kill", "-0", String(ownedPid)]).exitCode,
        ).not.toBe(0)
        expect(standIn.exitCode).toBeNull()
        expect(await readServiceStatus()).toBe(sharedBefore)
      } finally {
        await owned?.dispose()
        await stop(standIn)
      }
    }, 40_000)

    it("does not start a server when Keymaxxer is disabled", async () => {
      const sharedBefore = await readServiceStatus()
      const { selectHarnessOpenCodeConnection } = await import(
        "../src/lib/owned-server.js"
      )
      expect(selectHarnessOpenCodeConnection({})).toEqual({ kind: "default" })
      expect(await readServiceStatus()).toBe(sharedBefore)
    })

    it("fails closed on startup failure and does not leave the child running", async () => {
      const directory = await mkdtemp(join(tmpdir(), "opencode-owned-fail-"))
      const marker = `ber33-orphan-${Date.now()}`
      const binary = join(directory, marker)
      try {
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            `echo ${JSON.stringify(marker)}`,
            `echo ${JSON.stringify(probeUrl)} >&2`,
            'echo "$OPENCODE_SERVER_PASSWORD" >&2',
            "sleep 60",
            "",
          ].join("\n"),
        )
        await chmod(binary, 0o700)
        await expect(
          startOwnedOpenCodeServer({
            keymaxxerMcpUrl: probeUrl,
            binary,
            readyTimeoutMs: 400,
            environment: { PATH: process.env.PATH ?? "" },
          }),
        ).rejects.toThrow(/shared OpenCode service was not used/)
        const listed = Bun.spawnSync(["pgrep", "-f", marker], {
          stdout: "pipe",
          stderr: "ignore",
        })
        expect(listed.exitCode).not.toBe(0)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, 15_000)

    it("does not put the capability URL or server password in the startup error", async () => {
      const directory = await mkdtemp(join(tmpdir(), "opencode-owned-redact-"))
      const binary = join(directory, "opencode")
      try {
        await writeFile(
          binary,
          [
            "#!/bin/sh",
            `echo ${JSON.stringify(probeUrl)} >&2`,
            'echo "password=$OPENCODE_SERVER_PASSWORD" >&2',
            "exit 1",
            "",
          ].join("\n"),
        )
        await chmod(binary, 0o700)
        let message = ""
        try {
          await startOwnedOpenCodeServer({
            keymaxxerMcpUrl: probeUrl,
            binary,
            readyTimeoutMs: 2_000,
            environment: { PATH: process.env.PATH ?? "" },
          })
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        expect(message).toContain("shared OpenCode service was not used")
        assertSecretAbsent(message, probeUrl, "startup error")
        expect(message).not.toContain("ber33-owned-probe")
        expect(message).not.toMatch(/[A-Za-z0-9_-]{40,}/)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
