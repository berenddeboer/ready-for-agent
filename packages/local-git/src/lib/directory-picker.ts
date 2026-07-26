import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { Context, Effect, Layer, Result } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type DirectoryPickerCommand = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

const commandExistsOnPath = (
  command: string,
  pathEnv: string | undefined = process.env.PATH,
): boolean => {
  if (pathEnv === undefined || pathEnv.length === 0) {
    return false
  }
  for (const directory of pathEnv.split(delimiter)) {
    if (directory.length === 0) {
      continue
    }
    try {
      accessSync(join(directory, command), constants.X_OK)
      return true
    } catch {
      // keep looking
    }
  }
  return false
}

const powershellFolderBrowser = [
  "-NoProfile",
  "-Command",
  [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "$dialog.Description = 'Choose a local Git repository';",
    "$dialog.ShowNewFolderButton = $false;",
    "if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 };",
    "Write-Output $dialog.SelectedPath",
  ].join(" "),
] as const

/**
 * Resolve a host-side folder dialog command for the current platform.
 * Returns null when no supported tool is available (path text field still works).
 */
export const resolveDirectoryPickerCommand = (
  platform: string = process.platform,
  commandExists: (command: string) => boolean = commandExistsOnPath,
  homeDirectory: string = homedir(),
): DirectoryPickerCommand | null => {
  if (platform === "darwin") {
    if (!commandExists("osascript")) {
      return null
    }
    return {
      command: "osascript",
      args: [
        "-e",
        'POSIX path of (choose folder with prompt "Choose a local Git repository")',
      ],
    }
  }

  if (platform === "linux") {
    if (commandExists("zenity")) {
      return {
        command: "zenity",
        args: [
          "--file-selection",
          "--directory",
          "--title=Choose a local Git repository",
        ],
      }
    }
    if (commandExists("kdialog")) {
      return {
        command: "kdialog",
        // Open on the user's home, not the Harness process cwd.
        args: ["--getexistingdirectory", homeDirectory],
      }
    }
    return null
  }

  if (platform === "win32") {
    if (!commandExists("powershell") && !commandExists("powershell.exe")) {
      return null
    }
    return {
      command: commandExists("powershell") ? "powershell" : "powershell.exe",
      args: [...powershellFolderBrowser],
    }
  }

  return null
}

/**
 * Whether the host likely has a session that can present a GUI folder dialog.
 * Linux headless/CI without DISPLAY/WAYLAND_DISPLAY cannot open zenity/kdialog.
 * Darwin and Windows have no cheap reliable probe here.
 */
export const hasHostGraphicalSession = (
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (platform === "linux") {
    const display = env.DISPLAY?.trim() ?? ""
    const wayland = env.WAYLAND_DISPLAY?.trim() ?? ""
    return display.length > 0 || wayland.length > 0
  }
  return true
}

/**
 * Browse button availability: dialog tool on PATH and (on Linux) a graphical session.
 */
export const isDirectoryPickerAvailable = (
  platform: string = process.platform,
  commandExists: (command: string) => boolean = commandExistsOnPath,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (!hasHostGraphicalSession(platform, env)) {
    return false
  }
  return resolveDirectoryPickerCommand(platform, commandExists) !== null
}

/**
 * Trim and strip trailing directory separators while keeping filesystem roots
 * (`/` and `C:\`) intact.
 */
export const normalizePickedDirectoryPath = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  // Roots: bare `/` and Windows drive letters (`C:\` or `C:`).
  if (trimmed === "/") {
    return "/"
  }
  const driveRoot = /^([A-Za-z]):\\?$/.exec(trimmed)
  if (driveRoot?.[1] !== undefined) {
    return `${driveRoot[1].toUpperCase()}:\\`
  }
  // Only strip separators that follow a non-separator character.
  return trimmed.replace(/(?<=[^/\\])[/\\]+$/, "")
}

export class DirectoryPicker extends Context.Service<
  DirectoryPicker,
  {
    readonly available: Effect.Effect<boolean>
    /**
     * Open a host OS folder dialog.
     * Returns the absolute path, or null when the user cancels, no dialog
     * tool is available, or the dialog process fails. Cancel and launch
     * failures are intentionally indistinguishable (OS exit codes overlap);
     * the path field remains the reliable fallback.
     */
    readonly pick: Effect.Effect<string | null>
  }
>()("@ready-for-agent/DirectoryPicker") {
  static readonly layer = (
    options: {
      readonly platform?: string
      readonly commandExists?: (command: string) => boolean
      readonly env?: NodeJS.ProcessEnv
    } = {},
  ) =>
    Layer.effect(
      DirectoryPicker,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const platform = options.platform ?? process.platform
        const commandExists = options.commandExists ?? commandExistsOnPath
        const env = options.env ?? process.env

        const available = Effect.sync(() =>
          isDirectoryPickerAvailable(platform, commandExists, env),
        )

        const pick = Effect.gen(function* () {
          if (!isDirectoryPickerAvailable(platform, commandExists, env)) {
            return null
          }
          const resolved = resolveDirectoryPickerCommand(
            platform,
            commandExists,
          )
          if (resolved === null) {
            return null
          }

          const result = yield* Effect.result(
            spawner.string(
              ChildProcess.make(resolved.command, [...resolved.args], {
                stdin: "ignore",
                stderr: "ignore",
              }),
            ),
          )

          if (Result.isFailure(result)) {
            // Cancel and most dialog launch failures share non-zero exits.
            return null
          }

          return normalizePickedDirectoryPath(result.success)
        }).pipe(Effect.withSpan("DirectoryPicker.pick"))

        return { available, pick }
      }),
    )
}
