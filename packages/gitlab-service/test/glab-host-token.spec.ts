import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  parseGlabAuthStatusShowToken,
  resolveGlabHostToken,
} from "../src/lib/glab-host-token.js"
import { describe, expect, test } from "bun:test"

describe("parseGlabAuthStatusShowToken", () => {
  test("extracts an unmasked token from legacy show-token output", () => {
    const output = `
git.drupalcode.org
  ✓ Logged in to git.drupalcode.org as berend (keyring)
  ✓ Token found: abcd.01.real-token-value
`
    expect(parseGlabAuthStatusShowToken(output)).toBe(
      "abcd.01.real-token-value",
    )
  })

  test("extracts token from glab main 'Token found in <source>:' shape", () => {
    const keyring = `
git.drupalcode.org
  ✓ Logged in to git.drupalcode.org as berend (keyring)
  ✓ Token found in operating system keyring: abcd.01.from-keyring
`
    expect(parseGlabAuthStatusShowToken(keyring)).toBe("abcd.01.from-keyring")

    const plaintext = `
gitlab.example.com
  ✓ Token found in configuration file (plaintext): cfg-token-value
`
    expect(parseGlabAuthStatusShowToken(plaintext)).toBe("cfg-token-value")
  })

  test("rejects masked tokens (status without --show-token)", () => {
    const legacy = `
git.drupalcode.org
  ✓ Token found: **************************
`
    expect(parseGlabAuthStatusShowToken(legacy)).toBeNull()

    const withSource = `
git.drupalcode.org
  ✓ Token found in operating system keyring: **************************
`
    expect(parseGlabAuthStatusShowToken(withSource)).toBeNull()
  })

  test("returns null when the host is not authenticated", () => {
    const output = `
X not-a-real-host.example has not been authenticated with glab; run \`glab auth login --hostname not-a-real-host.example\` to authenticate.
`
    expect(parseGlabAuthStatusShowToken(output)).toBeNull()
  })

  test("accepts token present when API call failed (offline/outage)", () => {
    const output = `
git.drupalcode.org
  x git.drupalcode.org: API call failed: Get "https://git.drupalcode.org/api/v4/user": connection refused
  ✓ Token found in operating system keyring: host-local-token
ERROR
X could not authenticate to one or more of the configured GitLab instances.
`
    expect(parseGlabAuthStatusShowToken(output)).toBe("host-local-token")
  })
})

describe("resolveGlabHostToken", () => {
  const mockSpawner = (options: {
    readonly hostTokens: ReadonlyMap<string, string>
    readonly exitCode?: number
  }) => {
    const commands: Array<ReadonlyArray<string>> = []
    const encoder = new TextEncoder()
    const service = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("expected standard command")
        }
        commands.push([command.command, ...command.args])
        const hostIndex = command.args.indexOf("--hostname")
        const host = hostIndex >= 0 ? (command.args[hostIndex + 1] ?? "") : ""
        const token = options.hostTokens.get(host)
        const showToken = command.args.includes("--show-token")
        const body =
          token === undefined || !showToken
            ? `X ${host} has not been authenticated with glab\n`
            : `${host}\n  x API call failed\n  ✓ Token found: ${token}\nERROR\nX could not authenticate\n`
        const bytes = encoder.encode(body)
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(
              token === undefined ? 1 : (options.exitCode ?? 1),
            ),
          ),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: {
            onStart: () => Effect.void,
            onInput: () => Effect.void,
            onEnd: () => Effect.void,
          } as never,
          stdout: Stream.succeed(bytes),
          stderr: Stream.empty,
          all: Stream.succeed(bytes),
          getInputFd: () =>
            ({
              onStart: () => Effect.void,
              onInput: () => Effect.void,
              onEnd: () => Effect.void,
            }) as never,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      }),
    )
    return { commands, service }
  }

  test("accepts host token even when glab exits non-zero after API failure", async () => {
    const glab = mockSpawner({
      hostTokens: new Map([["git.drupalcode.org", "token-for-drupalcode"]]),
      exitCode: 1,
    })

    const token = await Effect.runPromise(
      resolveGlabHostToken({
        forgeHost: "git.drupalcode.org",
        spawner: glab.service,
      }),
    )

    expect(token).toBe("token-for-drupalcode")
    expect(glab.commands[0]).toEqual([
      "glab",
      "auth",
      "status",
      "--hostname",
      "git.drupalcode.org",
      "--show-token",
    ])
  })

  test("rejects unconfigured hosts (no config-get fallback path)", async () => {
    const glab = mockSpawner({
      hostTokens: new Map([["git.drupalcode.org", "token-for-drupalcode"]]),
    })

    const token = await Effect.runPromise(
      resolveGlabHostToken({
        forgeHost: "not-a-real-host.example",
        spawner: glab.service,
      }),
    )

    expect(token).toBeNull()
    expect(
      glab.commands.some(
        (args) => args.includes("config") && args.includes("token"),
      ),
    ).toBe(false)
  })
})
