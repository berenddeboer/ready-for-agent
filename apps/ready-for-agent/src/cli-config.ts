import { CliConfig, type Completions, Flag, GlobalFlag } from "effect/cli"

/**
 * Stable Effect 4.0.4 adds `--wizard` and powershell/pwsh to the default
 * built-ins. The operator contract stays the previous set: help, version,
 * bash/zsh/fish/sh completions (`sh` still prints bash), and log level.
 */
const completionShells: ReadonlyArray<readonly [string, Completions.Shell]> = [
  ["bash", "bash"],
  ["zsh", "zsh"],
  ["fish", "fish"],
  ["sh", "bash"],
]

const completions = GlobalFlag.Action({
  flag: Flag.ChoiceWithValue("completions", completionShells).pipe(
    Flag.optional,
    Flag.withMetavar("<bash|zsh|fish|sh>"),
    Flag.withDescription("Print shell completion script"),
  ),
  run: GlobalFlag.Completions.run,
})

const operatorCliBuiltIns = [
  GlobalFlag.Help,
  GlobalFlag.Version,
  completions,
  GlobalFlag.LogLevel,
]

export const operatorCliConfigLayer = CliConfig.layer({
  builtIns: operatorCliBuiltIns,
})
