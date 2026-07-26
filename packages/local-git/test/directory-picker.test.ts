import {
  hasHostGraphicalSession,
  isDirectoryPickerAvailable,
  normalizePickedDirectoryPath,
  resolveDirectoryPickerCommand,
} from "../src/lib/directory-picker.js"
import { describe, expect, test } from "bun:test"

describe("resolveDirectoryPickerCommand", () => {
  test("darwin uses osascript when available", () => {
    const resolved = resolveDirectoryPickerCommand(
      "darwin",
      (command) => command === "osascript",
    )
    expect(resolved).not.toBeNull()
    expect(resolved?.command).toBe("osascript")
    expect(resolved?.args.join(" ")).toContain("choose folder")
  })

  test("darwin unavailable without osascript", () => {
    expect(resolveDirectoryPickerCommand("darwin", () => false)).toBeNull()
  })

  test("linux prefers zenity over kdialog", () => {
    const resolved = resolveDirectoryPickerCommand("linux", (command) =>
      ["zenity", "kdialog"].includes(command),
    )
    expect(resolved?.command).toBe("zenity")
    expect(resolved?.args).toContain("--directory")
  })

  test("linux falls back to kdialog starting at home", () => {
    const resolved = resolveDirectoryPickerCommand(
      "linux",
      (command) => command === "kdialog",
      "/home/operator",
    )
    expect(resolved?.command).toBe("kdialog")
    expect(resolved?.args).toEqual(["--getexistingdirectory", "/home/operator"])
  })

  test("linux unavailable without dialog tools", () => {
    expect(resolveDirectoryPickerCommand("linux", () => false)).toBeNull()
  })

  test("win32 uses powershell folder browser", () => {
    const resolved = resolveDirectoryPickerCommand(
      "win32",
      (command) => command === "powershell",
    )
    expect(resolved?.command).toBe("powershell")
    expect(resolved?.args.join(" ")).toContain("FolderBrowserDialog")
  })

  test("unsupported platform returns null", () => {
    expect(resolveDirectoryPickerCommand("freebsd", () => true)).toBeNull()
  })
})

describe("hasHostGraphicalSession / isDirectoryPickerAvailable", () => {
  test("linux requires DISPLAY or WAYLAND_DISPLAY", () => {
    expect(hasHostGraphicalSession("linux", {})).toBe(false)
    expect(hasHostGraphicalSession("linux", { DISPLAY: "" })).toBe(false)
    expect(hasHostGraphicalSession("linux", { DISPLAY: ":0" })).toBe(true)
    expect(
      hasHostGraphicalSession("linux", { WAYLAND_DISPLAY: "wayland-0" }),
    ).toBe(true)
  })

  test("darwin and win32 do not require DISPLAY", () => {
    expect(hasHostGraphicalSession("darwin", {})).toBe(true)
    expect(hasHostGraphicalSession("win32", {})).toBe(true)
  })

  test("linux availability hides Browse when headless even if zenity exists", () => {
    const hasZenity = (command: string) => command === "zenity"
    expect(isDirectoryPickerAvailable("linux", hasZenity, {})).toBe(false)
    expect(
      isDirectoryPickerAvailable("linux", hasZenity, { DISPLAY: ":0" }),
    ).toBe(true)
  })
})

describe("normalizePickedDirectoryPath", () => {
  test("trims and strips trailing separators on normal paths", () => {
    expect(normalizePickedDirectoryPath("  /home/me/repo/  ")).toBe(
      "/home/me/repo",
    )
    expect(normalizePickedDirectoryPath("C:\\Users\\me\\repo\\")).toBe(
      "C:\\Users\\me\\repo",
    )
  })

  test("preserves filesystem roots", () => {
    expect(normalizePickedDirectoryPath("/")).toBe("/")
    expect(normalizePickedDirectoryPath("C:\\")).toBe("C:\\")
  })

  test("rejects empty input", () => {
    expect(normalizePickedDirectoryPath("   ")).toBeNull()
  })
})
