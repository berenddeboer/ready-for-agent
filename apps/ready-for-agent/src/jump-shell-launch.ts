import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

/**
 * Shell that will read the queued exec line.
 * POSIX covers bash, zsh, ksh, and sh-family quoting.
 * Fish has its own single-quote escapes.
 */
export type ShellFamily = "posix" | "fish"

export type InteractiveShellInvocation = {
  readonly family: ShellFamily
  readonly arguments: readonly string[]
}

const loginPosixShells = new Set(["bash", "zsh", "ksh", "mksh"])
const plainPosixShells = new Set(["sh", "dash", "ash", "busybox"])

/**
 * Argv tmux executes directly (not via `sh -c`) so the pane is an interactive
 * shell that reads terminal input. Login flags match tmux's empty
 * default-command behavior for shells that have them. dash and plain sh do
 * not; passing `-l` would make those binaries reject the pane.
 */
export const interactiveShellInvocation = (
  shellPath: string,
): InteractiveShellInvocation | null => {
  const name = basename(shellPath)
  if (name === "fish") {
    return { family: "fish", arguments: [shellPath, "-l"] }
  }
  if (loginPosixShells.has(name)) {
    return { family: "posix", arguments: [shellPath, "-l"] }
  }
  if (plainPosixShells.has(name)) {
    return { family: "posix", arguments: [shellPath] }
  }
  return null
}

export const quotePosixShell = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

export const quoteFishShell = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`

export const queuedExecLine = (
  family: ShellFamily,
  launcherPath: string,
): string =>
  `exec ${family === "fish" ? quoteFishShell(launcherPath) : quotePosixShell(launcherPath)}`

/**
 * Write the script tmux execs after the worktree shell starts.
 * Jump and the CLI contract both use this writer so the executed file is the
 * production script, not a test copy.
 */
export const writeJumpLauncherScript = (input: {
  readonly directory: string
  readonly executableName: string
  readonly arguments: readonly string[]
  readonly tmuxExecutable?: string
  readonly modelPinArguments?: readonly string[]
}): string => {
  mkdirSync(input.directory, { recursive: true })
  const scriptPath = join(input.directory, "launch")
  writeFileSync(
    scriptPath,
    renderJumpLauncherScript({
      executableName: input.executableName,
      arguments: input.arguments,
      ...(input.tmuxExecutable === undefined
        ? {}
        : { tmuxExecutable: input.tmuxExecutable }),
      ...(input.modelPinArguments === undefined
        ? {}
        : { modelPinArguments: input.modelPinArguments }),
    }),
    { mode: 0o700 },
  )
  chmodSync(scriptPath, 0o700)
  return scriptPath
}

/**
 * Short script the interactive shell execs after its own startup.
 * The shell's environment and PATH are inherited. The executable name is
 * looked up then, not from the Jump process. Exec replaces the shell so the
 * pane closes when the agent exits. A failed lookup or exec prints an error
 * and keeps the dead pane (`remain-on-exit`) instead of sitting at a prompt.
 * A non-interactive POSIX shell exits when `exec` fails, so that report would
 * not run. bash continues after `shopt -s execfail`; other `/bin/sh` binaries
 * re-exec with bash before the script removes itself.
 * `tmuxExecutable` is the tmux binary Jump already used, so that report does
 * not depend on the activated PATH.
 */
export const renderJumpLauncherScript = (input: {
  readonly executableName: string
  readonly arguments: readonly string[]
  readonly tmuxExecutable?: string
  /**
   * OpenCode V2 model switch, run with the shell's executable before exec.
   * Omitted for unpinned OpenCode and every other Agent Backend.
   */
  readonly modelPinArguments?: readonly string[]
}): string => {
  const exe = quotePosixShell(input.executableName)
  const tmux = quotePosixShell(input.tmuxExecutable ?? "tmux")
  const execArgs =
    input.arguments.length === 0
      ? ""
      : ` ${input.arguments
          .map((argument) => quotePosixShell(argument))
          .join(" ")}`
  const modelPin =
    input.modelPinArguments === undefined
      ? ""
      : `"$exe"${input.modelPinArguments
          .map((argument) => ` ${quotePosixShell(argument)}`)
          .join("")}
pin_status=$?
if [ "$pin_status" -ne 0 ]; then
  fail "could not select the Work Item Agent Model on OpenCode (status $pin_status)."
fi
`
  return `#!/bin/sh
if [ -z "\${BASH_VERSION-}" ] && [ -x /bin/bash ]; then
  exec /bin/bash "$0" "$@"
fi
rm -f -- "$0"
exe=${exe}
missing="Agent Backend executable '$exe'"
missing="$missing was not found on the target shell PATH."
missing="$missing The worktree shell started, but the agent did not."
missing="$missing Make that executable available to an interactive"
missing="$missing shell in this worktree, then run jump again."
fail() {
  printf '%s\\n' "ready-for-agent jump: $1" >&2
  if [ -n "\${TMUX_PANE-}" ]; then
    ${tmux} set-option -p -t "$TMUX_PANE" remain-on-exit on \\
      >/dev/null 2>&1 || true
  fi
  exit 127
}
command -v "$exe" >/dev/null 2>&1 || fail "$missing"
if [ -n "\${BASH_VERSION-}" ]; then
  shopt -s execfail
fi
${modelPin}exec "$exe"${execArgs}
status=$?
exec_status="could not execute Agent Backend executable '$exe'"
if [ "$status" -eq 0 ]; then
  fail "$exec_status."
fi
fail "$exec_status (status $status)."
`
}
