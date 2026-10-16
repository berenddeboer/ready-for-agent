import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  interactiveShellInvocation,
  queuedExecLine,
  quoteFishShell,
  quotePosixShell,
  renderJumpLauncherScript,
} from "./jump-shell-launch.ts"
import { describe, expect, test } from "bun:test"

describe("jump shell launch", () => {
  test("quotes spaces and quotes for posix shells and fish", () => {
    const value = `work tree/quote's\\dir`
    expect(quotePosixShell(value)).toBe(`'work tree/quote'\\''s\\dir'`)
    expect(quoteFishShell(value)).toBe(`'work tree/quote\\'s\\\\dir'`)
    expect(queuedExecLine("posix", value)).toBe(
      `exec ${quotePosixShell(value)}`,
    )
    expect(queuedExecLine("fish", value)).toBe(`exec ${quoteFishShell(value)}`)
  })

  test("starts login shells that read input, and not shell -c", () => {
    expect(interactiveShellInvocation("/bin/bash")).toEqual({
      family: "posix",
      arguments: ["/bin/bash", "-l"],
    })
    expect(interactiveShellInvocation("/usr/bin/fish")).toEqual({
      family: "fish",
      arguments: ["/usr/bin/fish", "-l"],
    })
    expect(interactiveShellInvocation("/bin/zsh")).toEqual({
      family: "posix",
      arguments: ["/bin/zsh", "-l"],
    })
    expect(interactiveShellInvocation("/bin/sh")).toEqual({
      family: "posix",
      arguments: ["/bin/sh"],
    })
    expect(interactiveShellInvocation("/bin/dash")?.arguments).toEqual([
      "/bin/dash",
    ])
    expect(interactiveShellInvocation("/bin/nu")).toBeNull()
  })

  test("launcher preserves argv boundaries and reports a missing executable", () => {
    const script = renderJumpLauncherScript({
      executableName: "opencode",
      arguments: ["/work tree/quote's", "--note", `say "hello"`],
    })
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain("exe='opencode'")
    expect(script).toContain(
      `exec "$exe" '/work tree/quote'\\''s' '--note' 'say "hello"'`,
    )
    expect(script).toContain("was not found on the target shell PATH")
    expect(script).toContain("shopt -s execfail")
    expect(script).toContain('exec /bin/bash "$0" "$@"')
    expect(script).toContain("remain-on-exit on")
    expect(script).not.toContain("/usr/bin/opencode")
  })

  test("a failed exec reports in the pane instead of exiting the launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "rfa-launch-exec-"))
    const bin = join(root, "bin")
    const tmuxLog = join(root, "tmux.log")
    mkdirSync(bin)
    writeFileSync(tmuxLog, "")
    const tmuxPath = join(root, "tmux")
    writeFileSync(
      tmuxPath,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TMUX_LOG"\nexit 0\n',
      { mode: 0o755 },
    )
    chmodSync(tmuxPath, 0o755)
    const executable = (name: string, body: string) => {
      const path = join(bin, name)
      writeFileSync(path, body, { mode: 0o755 })
      chmodSync(path, 0o755)
    }
    const run = (executableName: string, path: string) => {
      const scriptPath = join(root, `launch-${executableName}`)
      writeFileSync(
        scriptPath,
        renderJumpLauncherScript({
          executableName,
          arguments: ["hello world", "quote's"],
          tmuxExecutable: tmuxPath,
        }),
        { mode: 0o700 },
      )
      chmodSync(scriptPath, 0o700)
      return spawnSync(scriptPath, [], {
        encoding: "utf8",
        env: {
          PATH: path,
          TMUX_PANE: "%9",
          TMUX_LOG: tmuxLog,
        },
      })
    }
    try {
      executable("rfa-jump-bad", "#!/no/such/rfa-interp\n")
      executable("rfa-jump-empty", "")
      executable(
        "rfa-jump-good",
        "#!/bin/sh\nprintf '%s\\n' \"$1\"\nprintf '%s\\n' \"$2\"\nexit 42\n",
      )
      const path = `${bin}:/usr/bin:/bin`
      const bad = run("rfa-jump-bad", path)
      expect(bad.status).toBe(127)
      expect(bad.stderr).toContain(
        "could not execute Agent Backend executable 'rfa-jump-bad'",
      )
      expect(bad.stderr).not.toContain("(status 0)")
      expect(readFileSync(tmuxLog, "utf8")).toContain(
        "set-option -p -t %9 remain-on-exit on",
      )
      writeFileSync(tmuxLog, "")
      const empty = run("rfa-jump-empty", path)
      expect(empty.status).toBe(127)
      expect(empty.stderr).toContain(
        "could not execute Agent Backend executable 'rfa-jump-empty'.",
      )
      expect(empty.stderr).not.toContain("(status 0)")
      expect(readFileSync(tmuxLog, "utf8")).toContain("remain-on-exit on")
      writeFileSync(tmuxLog, "")
      const missing = run("rfa-jump-missing", "/usr/bin:/bin")
      expect(missing.status).toBe(127)
      expect(missing.stderr).toContain("was not found on the target shell PATH")
      expect(readFileSync(tmuxLog, "utf8")).toContain("remain-on-exit on")
      writeFileSync(tmuxLog, "")
      const good = run("rfa-jump-good", path)
      expect(good.status).toBe(42)
      expect(good.stdout).toBe("hello world\nquote's\n")
      expect(readFileSync(tmuxLog, "utf8")).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("production jump sources do not mention environment managers", () => {
    const sources = ["jump-shell-launch.ts", "services/tmux.ts", "cli.ts"]
      .map((name) =>
        readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
      )
      .join("\n")
      .toLowerCase()
    expect(sources).not.toContain("direnv")
    expect(sources).not.toContain("mise")
  })
})
