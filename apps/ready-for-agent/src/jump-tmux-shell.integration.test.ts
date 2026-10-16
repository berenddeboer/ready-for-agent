import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { type JumpWindowInput, Tmux } from "./services/tmux.ts"
import { describe, expect, test } from "bun:test"

const tmuxBin = Bun.which("tmux")
const bashBin = Bun.which("bash")
const fishBin = Bun.which("fish")
const direnvBin = Bun.which("direnv")
const miseBin = Bun.which("mise")

const fixtureLine = [
  ["tmux", tmuxBin],
  ["bash", bashBin],
  ["fish", fishBin],
  ["direnv", direnvBin],
  ["mise", miseBin],
]
  .map(
    ([name, path]) =>
      `${name}: ${path === null ? "skipped, not on PATH" : "enabled"}`,
  )
  .join("; ")

const toolsReady = tmuxBin !== null && bashBin !== null
const managersReady = direnvBin !== null && miseBin !== null

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const parseFields = (text: string): Record<string, string> => {
  const record: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const index = line.indexOf("=")
    if (index === -1) {
      continue
    }
    record[line.slice(0, index)] = line.slice(index + 1)
  }
  return record
}

const writeExecutable = (path: string, body: string) => {
  writeFileSync(path, body, { mode: 0o755 })
}

const probeBody = (label: string) => `#!/bin/sh
result=$1
shift
{
  printf 'label=%s\\n' '${label}'
  printf 'argv0=%s\\n' "$0"
  printf 'cwd=%s\\n' "$(pwd)"
  printf 'marker=%s\\n' "\${RFA_JUMP_MARKER-}"
  printf 'direnv=%s\\n' "\${RFA_DIRENV_MARKER-}"
  printf 'mise=%s\\n' "\${RFA_MISE_MARKER-}"
  printf 'leak=%s\\n' "\${RFA_BASELINE_LEAK-}"
  i=1
  for arg in "$@"; do
    printf 'arg%d=%s\\n' "$i" "$arg"
    i=$((i + 1))
  done
} > "$result"
`

type ShellName = "bash" | "fish"

const runJump = (input: JumpWindowInput) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tmux = yield* Tmux
      yield* tmux.createJumpWindow(input)
    }).pipe(Effect.provide(Tmux.layer.pipe(Layer.provide(BunServices.layer)))),
  )

const testTimeoutMs = 60_000

const waitForText = async (path: string): Promise<string> => {
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    try {
      return readFileSync(path, "utf8")
    } catch {
      await delay(100)
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

describe("jump tmux shell fixtures", () => {
  test("records which isolated tools are available", () => {
    console.info(`jump shell fixtures — ${fixtureLine}`)
    expect(fixtureLine).toContain("tmux:")
    expect(fixtureLine).toContain("bash:")
  })
})

describe.skipIf(!toolsReady)("jump activates the target worktree shell", () => {
  const requireTmux = () => {
    if (tmuxBin === null || bashBin === null) {
      throw new Error("tmux and bash are required")
    }
    return { tmuxBin, bashBin }
  }

  const isolated = async (
    shell: ShellName,
    startup: string,
    body: (context: {
      readonly root: string
      readonly project: string
      readonly targetBin: string
      readonly socket: string
      readonly run: (input: JumpWindowInput) => Promise<void>
      readonly panes: () => string
      readonly capture: (paneId: string) => string
    }) => Promise<void>,
    options?: { readonly trust?: boolean },
  ) => {
    const bins = requireTmux()
    const root = mkdtempSync(join(tmpdir(), "rfa-jump-shell-"))
    const home = join(root, "home")
    const project = join(root, "work tree", "quote's")
    const callerBin = join(root, "caller-bin")
    const targetBin = join(root, "target-bin")
    const socket = join(root, "tmux.sock")
    mkdirSync(home, { recursive: true })
    mkdirSync(project, { recursive: true })
    mkdirSync(callerBin, { recursive: true })
    mkdirSync(targetBin, { recursive: true })
    writeExecutable(join(callerBin, "rfa-jump-probe"), probeBody("caller"))
    writeExecutable(join(targetBin, "rfa-jump-probe"), probeBody("target"))
    if (shell === "bash") {
      writeFileSync(join(home, ".bash_profile"), startup)
    } else {
      mkdirSync(join(home, ".config", "fish"), { recursive: true })
      writeFileSync(join(home, ".config", "fish", "config.fish"), startup)
    }
    const toolBins = [direnvBin, miseBin]
      .filter((path): path is string => path !== null)
      .map((path) => join(path, ".."))
    const serverPath = [callerBin, ...toolBins, "/usr/bin", "/bin"].join(":")
    const serverEnv: NodeJS.ProcessEnv = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      MISE_CONFIG_DIR: join(home, ".config", "mise"),
      MISE_DATA_DIR: join(home, ".local", "share", "mise"),
      MISE_CACHE_DIR: join(home, ".cache", "mise"),
      MISE_GLOBAL_CONFIG_FILE: join(home, ".config", "mise", "config.toml"),
      PATH: serverPath,
      TERM: "xterm-256color",
      RFA_BASELINE_LEAK: "from-tmux-server",
    }
    const shellPath = shell === "bash" ? bins.bashBin : (fishBin ?? "")
    writeFileSync(
      join(root, "tmux.conf"),
      `set -g default-shell ${shellPath}\nset -g default-command ""\nset -g status off\nset -g remain-on-exit off\n`,
    )
    if (options?.trust === true) {
      const trusted = spawnSync(
        bins.bashBin,
        [
          "--noprofile",
          "--norc",
          "-c",
          'cd "$1" && direnv allow && mise trust',
          "bash",
          project,
        ],
        { env: serverEnv, encoding: "utf8" },
      )
      if (trusted.status !== 0) {
        throw new Error(
          `tool trust failed: ${trusted.stderr}\n${trusted.stdout}`,
        )
      }
    }
    const started = spawnSync(
      bins.tmuxBin,
      [
        "-S",
        socket,
        "-f",
        join(root, "tmux.conf"),
        "new-session",
        "-d",
        "-s",
        "jump",
        "-c",
        project,
        "--",
        "/bin/sleep",
        "1000",
      ],
      { env: serverEnv, encoding: "utf8" },
    )
    if (started.status !== 0) {
      rmSync(root, { recursive: true, force: true })
      throw new Error(
        `private tmux server failed: ${started.stderr}\n${started.stdout}`,
      )
    }
    const previousTmux = process.env.TMUX
    const tmuxClient = (args: readonly string[]) =>
      spawnSync(bins.tmuxBin, ["-S", socket, ...args], { encoding: "utf8" })
    try {
      await body({
        root,
        project,
        targetBin,
        socket,
        run: async (input) => {
          process.env.TMUX = `${socket},1,0`
          await runJump(input)
        },
        panes: () =>
          tmuxClient([
            "list-panes",
            "-a",
            "-F",
            "#{pane_id} #{pane_dead} #{@rfa-agent} #{pane_current_path}",
          ]).stdout,
        // -J joins lines wrapped for the pane width. A narrow CI pane
        // otherwise splits words, and collapsing whitespace hides the error.
        capture: (paneId) =>
          tmuxClient(["capture-pane", "-p", "-J", "-t", paneId]).stdout,
      })
    } finally {
      if (previousTmux === undefined) {
        delete process.env.TMUX
      } else {
        process.env.TMUX = previousTmux
      }
      spawnSync(bins.tmuxBin, ["-S", socket, "kill-server"], {
        encoding: "utf8",
      })
      rmSync(root, { recursive: true, force: true })
    }
  }

  const bashHook = (targetBin: string) =>
    `export PROMPT_COMMAND='sleep 0.3; export RFA_JUMP_MARKER=from-hook; export PATH="${targetBin}:$PATH"'`

  test(
    "bash sees a slow prompt hook, the target cwd, and the target executable",
    async () => {
      const bins = requireTmux()
      let targetBin = ""
      let project = ""
      await isolated("bash", "", async (context) => {
        targetBin = context.targetBin
        project = context.project
        writeFileSync(
          join(context.root, "home", ".bash_profile"),
          bashHook(targetBin),
        )
        const resultPath = join(context.root, "result")
        const sessionId = "11111111-1111-4111-8111-111111111111"
        const input: JumpWindowInput = {
          sessionId,
          workingDirectory: project,
          agentExecutable: "rfa-jump-probe",
          agentArguments: [resultPath, project, "hello world", "quote's"],
        }
        await context.run(input)
        const first = parseFields(await waitForText(resultPath))
        expect(first.label).toBe("target")
        expect(first.argv0?.startsWith(targetBin)).toBe(true)
        expect(first.cwd).toBe(project)
        expect(first.marker).toBe("from-hook")
        expect(first.leak).toBe("from-tmux-server")
        expect(first.arg1).toBe(project)
        expect(first.arg2).toBe("hello world")
        expect(first.arg3).toBe("quote's")
        const started = Date.now()
        while (Date.now() - started < 5_000) {
          if (!context.panes().includes(" 0 1")) {
            break
          }
          await delay(100)
        }
        expect(context.panes()).not.toContain(" 0 1")
        rmSync(resultPath)
        await context.run(input)
        const second = parseFields(await waitForText(resultPath))
        expect(second.label).toBe("target")
        expect(second.cwd).toBe(project)
        expect(second.marker).toBe("from-hook")
      })
      expect(targetBin.length).toBeGreaterThan(0)
      expect(project).toContain("quote's")
      expect(bins.bashBin.endsWith("/bash")).toBe(true)
    },
    testTimeoutMs,
  )

  test(
    "a missing executable is reported on a dead pane and the next jump can launch",
    async () => {
      await isolated("bash", ":\n", async (context) => {
        const sessionId = "22222222-2222-4222-8222-222222222222"
        await context.run({
          sessionId,
          workingDirectory: context.project,
          agentExecutable: "rfa-jump-missing",
          agentArguments: [],
        })
        const started = Date.now()
        let listing = ""
        while (Date.now() - started < 8_000) {
          listing = context.panes()
          if (listing.includes(" 1 1")) {
            break
          }
          await delay(100)
        }
        expect(listing).toContain(" 1 1")
        const paneId = listing
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0])
          .find((_id, index) => listing.split("\n")[index]?.includes(" 1 1"))
        expect(paneId).toBeDefined()
        const screen = (context.capture(paneId ?? "") ?? "").replaceAll(
          /\s+/g,
          " ",
        )
        expect(screen).toContain("was not found on the target shell PATH")
        expect(screen).toContain("rfa-jump-missing")
        writeFileSync(
          join(context.root, "home", ".bash_profile"),
          `export PATH="${context.targetBin}:$PATH"\n`,
        )
        const resultPath = join(context.root, "result")
        await context.run({
          sessionId,
          workingDirectory: context.project,
          agentExecutable: "rfa-jump-probe",
          agentArguments: [resultPath],
        })
        const launched = parseFields(await waitForText(resultPath))
        expect(launched.label).toBe("target")
        expect(launched.cwd).toBe(context.project)
        expect(launched.leak).toBe("from-tmux-server")
      })
    },
    testTimeoutMs,
  )

  test(
    "an executable that cannot be exec'd stays on a dead pane",
    async () => {
      await isolated("bash", ":\n", async (context) => {
        const callerBin = join(context.root, "caller-bin")
        writeExecutable(
          join(callerBin, "rfa-jump-bad"),
          "#!/no/such/rfa-interp\nprintf '%s\\n' ran\n",
        )
        writeFileSync(
          join(context.root, "home", ".bash_profile"),
          `export PATH="${callerBin}:$PATH"\n`,
        )
        const sessionId = "66666666-6666-4666-8666-666666666666"
        await context.run({
          sessionId,
          workingDirectory: context.project,
          agentExecutable: "rfa-jump-bad",
          agentArguments: [],
        })
        const started = Date.now()
        let listing = ""
        while (Date.now() - started < 8_000) {
          listing = context.panes()
          if (listing.includes(" 1 1")) {
            break
          }
          await delay(100)
        }
        expect(listing).toContain(" 1 1")
        const paneId = listing
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0])
          .find((_id, index) => listing.split("\n")[index]?.includes(" 1 1"))
        expect(paneId).toBeDefined()
        const screen = (context.capture(paneId ?? "") ?? "").replaceAll(
          /\s+/g,
          " ",
        )
        expect(screen).toContain("could not execute")
        expect(screen).toContain("rfa-jump-bad")
      })
    },
    testTimeoutMs,
  )

  test.skipIf(fishBin === null)(
    "fish sees a slow prompt hook and the target executable",
    async () => {
      await isolated("fish", "", async (context) => {
        writeFileSync(
          join(context.root, "home", ".config", "fish", "config.fish"),
          `function __rfa_prepare --on-event fish_prompt\n    sleep 0.3\n    set -gx RFA_JUMP_MARKER from-fish-hook\n    set -gx PATH "${context.targetBin}" $PATH\nend\n`,
        )
        const resultPath = join(context.root, "result")
        await context.run({
          sessionId: "33333333-3333-4333-8333-333333333333",
          workingDirectory: context.project,
          agentExecutable: "rfa-jump-probe",
          agentArguments: [resultPath, "fish arg"],
        })
        const record = parseFields(await waitForText(resultPath))
        expect(record.label).toBe("target")
        expect(record.cwd).toBe(context.project)
        expect(record.marker).toBe("from-fish-hook")
        expect(record.arg1).toBe("fish arg")
        expect(record.leak).toBe("from-tmux-server")
      })
    },
    testTimeoutMs,
  )

  const managerOrders = ["direnv-then-mise", "mise-then-direnv"] as const

  describe.skipIf(!managersReady)(
    "direnv and mise in both registration orders",
    () => {
      const bashStartup = (
        order: (typeof managerOrders)[number],
        targetBin: string,
      ) => {
        const hooks =
          order === "direnv-then-mise"
            ? 'eval "$(direnv hook bash)"\neval "$(mise activate bash)"\n'
            : 'eval "$(mise activate bash)"\neval "$(direnv hook bash)"\n'
        // Prepend a slow hook without expanding the manager's own
        // PROMPT_COMMAND, which may be a string or a bash array.
        return `${hooks}_rfa_prepare() {
  sleep 0.3
  export PATH="${targetBin}:$PATH"
}
_rfa_decl=$(declare -p PROMPT_COMMAND 2>&1 || true)
case "$_rfa_decl" in
  "declare -a"*)
    PROMPT_COMMAND=(_rfa_prepare "\${PROMPT_COMMAND[@]}")
    ;;
  *)
    PROMPT_COMMAND="_rfa_prepare\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
    ;;
esac
`
      }

      const fishStartup = (
        order: (typeof managerOrders)[number],
        targetBin: string,
      ) => {
        const hooks =
          order === "direnv-then-mise"
            ? "direnv hook fish | source\nmise activate fish | source\n"
            : "mise activate fish | source\ndirenv hook fish | source\n"
        return `${hooks}function __rfa_prepare --on-event fish_prompt\n    sleep 0.3\n    set -gx PATH "${targetBin}" $PATH\nend\n`
      }

      for (const order of managerOrders) {
        test(
          `bash ${order} exports both target markers`,
          async () => {
            await isolated("bash", ":", async (context) => {
              writeFileSync(
                join(context.project, ".envrc"),
                "export RFA_DIRENV_MARKER=direnv-target\n",
              )
              writeFileSync(
                join(context.project, "mise.toml"),
                '[env]\nRFA_MISE_MARKER = "mise-target"\n',
              )
              writeFileSync(
                join(context.root, "home", ".bash_profile"),
                bashStartup(order, context.targetBin),
              )
              const trusted = spawnSync(
                bashBin ?? "bash",
                [
                  "--noprofile",
                  "--norc",
                  "-c",
                  'cd "$1" && direnv allow && mise trust',
                  "bash",
                  context.project,
                ],
                {
                  env: {
                    HOME: join(context.root, "home"),
                    XDG_CONFIG_HOME: join(context.root, "home", ".config"),
                    XDG_DATA_HOME: join(
                      context.root,
                      "home",
                      ".local",
                      "share",
                    ),
                    XDG_STATE_HOME: join(
                      context.root,
                      "home",
                      ".local",
                      "state",
                    ),
                    MISE_CONFIG_DIR: join(
                      context.root,
                      "home",
                      ".config",
                      "mise",
                    ),
                    MISE_DATA_DIR: join(
                      context.root,
                      "home",
                      ".local",
                      "share",
                      "mise",
                    ),
                    MISE_CACHE_DIR: join(
                      context.root,
                      "home",
                      ".cache",
                      "mise",
                    ),
                    MISE_GLOBAL_CONFIG_FILE: join(
                      context.root,
                      "home",
                      ".config",
                      "mise",
                      "config.toml",
                    ),
                    PATH: [
                      dirnameOf(direnvBin),
                      dirnameOf(miseBin),
                      "/usr/bin",
                      "/bin",
                    ].join(":"),
                    TERM: "xterm-256color",
                  },
                  encoding: "utf8",
                },
              )
              if (trusted.status !== 0) {
                throw new Error(
                  `trust failed: ${trusted.stderr}\n${trusted.stdout}`,
                )
              }
              const resultPath = join(context.root, "result")
              await context.run({
                sessionId: `44444444-4444-4444-8444-${order.length.toString().padStart(12, "0")}`,
                workingDirectory: context.project,
                agentExecutable: "rfa-jump-probe",
                agentArguments: [resultPath],
              })
              const record = parseFields(await waitForText(resultPath))
              expect(record.label).toBe("target")
              expect(record.cwd).toBe(context.project)
              expect(record.direnv).toBe("direnv-target")
              expect(record.mise).toBe("mise-target")
              expect(record.leak).toBe("from-tmux-server")
            })
          },
          testTimeoutMs,
        )

        test.skipIf(fishBin === null)(
          `fish ${order} exports both target markers`,
          async () => {
            await isolated("fish", "", async (context) => {
              writeFileSync(
                join(context.project, ".envrc"),
                "export RFA_DIRENV_MARKER=direnv-fish\n",
              )
              writeFileSync(
                join(context.project, "mise.toml"),
                '[env]\nRFA_MISE_MARKER = "mise-fish"\n',
              )
              writeFileSync(
                join(context.root, "home", ".config", "fish", "config.fish"),
                fishStartup(order, context.targetBin),
              )
              const trusted = spawnSync(
                bashBin ?? "bash",
                [
                  "--noprofile",
                  "--norc",
                  "-c",
                  'cd "$1" && direnv allow && mise trust',
                  "bash",
                  context.project,
                ],
                {
                  env: {
                    HOME: join(context.root, "home"),
                    XDG_CONFIG_HOME: join(context.root, "home", ".config"),
                    XDG_DATA_HOME: join(
                      context.root,
                      "home",
                      ".local",
                      "share",
                    ),
                    XDG_STATE_HOME: join(
                      context.root,
                      "home",
                      ".local",
                      "state",
                    ),
                    MISE_CONFIG_DIR: join(
                      context.root,
                      "home",
                      ".config",
                      "mise",
                    ),
                    MISE_DATA_DIR: join(
                      context.root,
                      "home",
                      ".local",
                      "share",
                      "mise",
                    ),
                    MISE_CACHE_DIR: join(
                      context.root,
                      "home",
                      ".cache",
                      "mise",
                    ),
                    MISE_GLOBAL_CONFIG_FILE: join(
                      context.root,
                      "home",
                      ".config",
                      "mise",
                      "config.toml",
                    ),
                    PATH: [
                      dirnameOf(direnvBin),
                      dirnameOf(miseBin),
                      "/usr/bin",
                      "/bin",
                    ].join(":"),
                  },
                  encoding: "utf8",
                },
              )
              if (trusted.status !== 0) {
                throw new Error(
                  `trust failed: ${trusted.stderr}\n${trusted.stdout}`,
                )
              }
              const resultPath = join(context.root, "result")
              await context.run({
                sessionId: `55555555-5555-4555-8555-${order.length.toString().padStart(12, "0")}`,
                workingDirectory: context.project,
                agentExecutable: "rfa-jump-probe",
                agentArguments: [resultPath],
              })
              const record = parseFields(await waitForText(resultPath))
              expect(record.label).toBe("target")
              expect(record.direnv).toBe("direnv-fish")
              expect(record.mise).toBe("mise-fish")
              expect(record.cwd).toBe(context.project)
              expect(record.leak).toBe("from-tmux-server")
            })
          },
          testTimeoutMs,
        )
      }
    },
  )
})

const dirnameOf = (path: string | null): string => {
  if (path === null) {
    return "/usr/bin"
  }
  const index = path.lastIndexOf("/")
  return index === -1 ? "/usr/bin" : path.slice(0, index)
}
