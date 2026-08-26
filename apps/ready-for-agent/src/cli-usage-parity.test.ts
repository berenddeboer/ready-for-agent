/**
 * Process-level Usage contract: lint, public inventory vs Effect help,
 * hidden metadata, and directory completion metadata.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const usageSpecPath = join(packageRoot, "ready-for-agent.usage.kdl")

const PUBLIC_COMMANDS = [
  "start",
  "add",
  "candidates",
  "intake",
  "retry",
  "status",
  "jump",
] as const

const INTERNAL_TOKENS = [
  "--ready-for-agent-internal-github-helper",
  "--ready-for-agent-internal-gitlab-helper",
  "--ready-for-agent-internal-azure-devops-helper",
  "--ready-for-agent-internal-keymaxxer-sidecar",
  "ready-for-agent-internal-github-helper",
  "ready-for-agent-internal-gitlab-helper",
  "ready-for-agent-internal-azure-devops-helper",
  "ready-for-agent-internal-keymaxxer-sidecar",
] as const

const REPOSITORY_SELECTOR_FORMS = [
  "<forge-host>://<project-path>",
  "<forge-host>/<project-path>",
  "unique project path",
  "unique final project-path segment",
] as const

const GLOBAL_FLAG_CHOICES = {
  completions: ["bash", "zsh", "fish", "sh"],
  "log-level": [
    "all",
    "trace",
    "debug",
    "info",
    "warn",
    "warning",
    "error",
    "fatal",
    "none",
  ],
} as const

type UsageJson = {
  readonly min_usage_version?: string
  readonly about?: string
  readonly about_long?: string
  readonly examples?: ReadonlyArray<{ readonly code: string }>
  readonly complete?: Record<string, unknown>
  readonly cmd: UsageCommand
}

type UsageCommand = {
  readonly name: string
  readonly effect?: string
  readonly args: ReadonlyArray<UsageArg>
  readonly flags: ReadonlyArray<UsageFlag>
  readonly mounts?: ReadonlyArray<unknown>
  readonly complete?: Record<string, { readonly type_?: string }>
  readonly examples?: ReadonlyArray<{ readonly code: string }>
  readonly subcommands: Record<string, UsageCommand>
}

type UsageArg = {
  readonly name: string
  readonly required: boolean
  readonly hide?: boolean
  readonly help?: string
}

type UsageFlag = {
  readonly name: string
  readonly hide?: boolean
  readonly global?: boolean
  readonly long?: ReadonlyArray<string>
  readonly short?: ReadonlyArray<string>
  readonly arg?: {
    readonly choices?: { readonly choices?: ReadonlyArray<string> }
  }
}

type InventoryArg = {
  readonly name: string
  readonly required: boolean
}

type InventoryFlag = {
  readonly name: string
  readonly aliases: readonly string[]
  readonly choices: readonly string[]
}

type CommandInventory = {
  readonly args: readonly InventoryArg[]
  readonly flags: readonly InventoryFlag[]
}

type Inventory = Record<string, CommandInventory>

const workspaceRoot = join(packageRoot, "..", "..")
const pinnedUsage = join(workspaceRoot, "scripts", "run-pinned-usage.sh")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const parseUsageArg = (value: unknown): UsageArg | undefined => {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.required !== "boolean"
  ) {
    return undefined
  }
  return {
    name: value.name,
    required: value.required,
    ...(typeof value.hide === "boolean" ? { hide: value.hide } : {}),
    ...(typeof value.help === "string" ? { help: value.help } : {}),
  }
}

const parseUsageFlag = (value: unknown): UsageFlag | undefined => {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined
  }
  const argRecord = isRecord(value.arg) ? value.arg : undefined
  const choicesRecord =
    argRecord !== undefined && isRecord(argRecord.choices)
      ? argRecord.choices
      : undefined
  const listedChoices = choicesRecord?.choices
  return {
    name: value.name,
    ...(typeof value.hide === "boolean" ? { hide: value.hide } : {}),
    ...(typeof value.global === "boolean" ? { global: value.global } : {}),
    ...(isStringArray(value.long) ? { long: value.long } : {}),
    ...(isStringArray(value.short) ? { short: value.short } : {}),
    ...(argRecord === undefined
      ? {}
      : {
          arg: {
            ...(listedChoices === undefined || !isStringArray(listedChoices)
              ? {}
              : { choices: { choices: listedChoices } }),
          },
        }),
  }
}

const parseUsageCommand = (value: unknown): UsageCommand | undefined => {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !Array.isArray(value.args) ||
    !Array.isArray(value.flags) ||
    !isRecord(value.subcommands)
  ) {
    return undefined
  }
  const args: UsageArg[] = []
  for (const arg of value.args) {
    const parsed = parseUsageArg(arg)
    if (parsed === undefined) {
      return undefined
    }
    args.push(parsed)
  }
  const flags: UsageFlag[] = []
  for (const flag of value.flags) {
    const parsed = parseUsageFlag(flag)
    if (parsed === undefined) {
      return undefined
    }
    flags.push(parsed)
  }
  const subcommands: Record<string, UsageCommand> = {}
  for (const [name, command] of Object.entries(value.subcommands)) {
    const parsed = parseUsageCommand(command)
    if (parsed === undefined) {
      return undefined
    }
    subcommands[name] = parsed
  }
  const complete =
    value.complete === undefined
      ? undefined
      : isRecord(value.complete)
        ? Object.fromEntries(
            Object.entries(value.complete).flatMap(([name, completer]) => {
              if (!isRecord(completer)) {
                return []
              }
              return [
                [
                  name,
                  typeof completer.type_ === "string"
                    ? { type_: completer.type_ }
                    : {},
                ],
              ]
            }),
          )
        : undefined
  const examples = Array.isArray(value.examples)
    ? value.examples.flatMap((example) =>
        isRecord(example) && typeof example.code === "string"
          ? [{ code: example.code }]
          : [],
      )
    : undefined
  return {
    name: value.name,
    ...(typeof value.effect === "string" ? { effect: value.effect } : {}),
    args,
    flags,
    ...(Array.isArray(value.mounts) ? { mounts: value.mounts } : {}),
    ...(complete === undefined ? {} : { complete }),
    ...(examples === undefined ? {} : { examples }),
    subcommands,
  }
}

const parseUsageJson = (value: unknown): UsageJson | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const cmd = parseUsageCommand(value.cmd)
  if (cmd === undefined) {
    return undefined
  }
  const examples = Array.isArray(value.examples)
    ? value.examples.flatMap((example) =>
        isRecord(example) && typeof example.code === "string"
          ? [{ code: example.code }]
          : [],
      )
    : undefined
  return {
    ...(typeof value.min_usage_version === "string"
      ? { min_usage_version: value.min_usage_version }
      : {}),
    ...(typeof value.about === "string" ? { about: value.about } : {}),
    ...(typeof value.about_long === "string"
      ? { about_long: value.about_long }
      : {}),
    ...(examples === undefined ? {} : { examples }),
    ...(isRecord(value.complete) ? { complete: value.complete } : {}),
    cmd,
  }
}

const stripAnsi = (text: string): string => {
  const ansiEscape = String.fromCharCode(27)
  return text.split(ansiEscape).reduce((acc, chunk, index) => {
    if (index === 0) {
      return chunk
    }
    return acc + chunk.replace(/^\[[0-9;]*m/, "")
  }, "")
}

const runUsage = (
  args: readonly string[],
  cwd: string = packageRoot,
): {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
} => {
  const result = spawnSync("bash", [pinnedUsage, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

const requireUsage510 = (): void => {
  const version = runUsage(["--version"])
  expect(version.status, version.stderr).toBe(0)
  expect(version.stdout).toContain("5.1.0")
}

const usageJson = (): UsageJson => {
  const generated = runUsage(["generate", "json", "-f", usageSpecPath])
  expect(generated.status, generated.stderr).toBe(0)
  let parsed: unknown
  try {
    parsed = JSON.parse(generated.stdout)
  } catch {
    expect(generated.stdout, "Usage JSON").toMatch(/^\{/)
    throw new Error("Usage generate json did not emit JSON")
  }
  const spec = parseUsageJson(parsed)
  expect(spec, generated.stdout).toBeDefined()
  if (spec === undefined) {
    throw new Error("Usage JSON failed the public-inventory shape check")
  }
  return spec
}

const runEffectHelp = (args: readonly string[]): string => {
  const result = spawnSync(
    "bun",
    ["--conditions", "@ready-for-agent/source", "src/main.ts", ...args],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    },
  )
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  expect(result.status, output).toBe(0)
  return stripAnsi(output)
}

const sectionBody = (help: string, heading: string): string => {
  const lines = help.split("\n")
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) {
    return ""
  }
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Z][A-Z ]+$/.test(line.trim()) && line.trim() !== heading) {
      break
    }
    body.push(line)
  }
  return body.join("\n")
}

const parseHelpCommands = (help: string): string[] => {
  const names: string[] = []
  for (const line of sectionBody(help, "SUBCOMMANDS").split("\n")) {
    const match = line.trim().match(/^([a-z][a-z0-9-]*)\b/)
    if (match?.[1] !== undefined) {
      names.push(match[1])
    }
  }
  return names.sort()
}

const parseHelpArgs = (help: string): InventoryArg[] => {
  const args: InventoryArg[] = []
  for (const line of sectionBody(help, "ARGUMENTS").split("\n")) {
    const match = line.trim().match(/^([a-z][a-z0-9-]*)\b/i)
    if (match?.[1] === undefined) {
      continue
    }
    args.push({
      name: match[1],
      required: !line.includes("(optional)"),
    })
  }
  return args.sort((left, right) => left.name.localeCompare(right.name))
}

const parseFlagLine = (line: string): InventoryFlag | undefined => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("--") && !trimmed.startsWith("-")) {
    return undefined
  }
  const longNames = [...trimmed.matchAll(/--([a-z0-9-]+)/gi)].map(
    (match) => match[1] ?? "",
  )
  const name = longNames[0]
  if (name === undefined || name === "") {
    return undefined
  }
  const aliases = [...trimmed.matchAll(/(?<![a-z0-9-])-([a-z])\b/gi)]
    .map((match) => match[1] ?? "")
    .filter((alias) => alias.length === 1)
  const metavar = trimmed.match(/<([^>]+)>/)?.[1]
  const listed = trimmed.match(/\(choices:\s*([^)]+)\)/i)?.[1]
  const choices = [
    ...(metavar?.includes("|") ? metavar.split("|") : []),
    ...(listed?.split(",") ?? []).map((choice) => choice.trim()),
  ].filter((choice) => choice.length > 0)
  return {
    name,
    aliases: [...new Set(aliases)].sort(),
    choices: [...new Set(choices)].sort(),
  }
}

const parseHelpFlags = (help: string, heading: string): InventoryFlag[] => {
  const flags: InventoryFlag[] = []
  for (const line of sectionBody(help, heading).split("\n")) {
    const flag = parseFlagLine(line)
    if (flag !== undefined) {
      flags.push(flag)
    }
  }
  return flags.sort((left, right) => left.name.localeCompare(right.name))
}

const usageArgInventory = (args: ReadonlyArray<UsageArg>): InventoryArg[] =>
  args
    .filter((arg) => arg.hide !== true)
    .map((arg) => ({ name: arg.name, required: arg.required }))
    .sort((left, right) => left.name.localeCompare(right.name))

const usageFlagInventory = (flags: ReadonlyArray<UsageFlag>): InventoryFlag[] =>
  flags
    .filter((flag) => flag.hide !== true)
    .map((flag) => ({
      name: flag.name,
      aliases: [...(flag.short ?? [])].sort(),
      choices: [...(flag.arg?.choices?.choices ?? [])].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

const mergeFlags = (
  local: readonly InventoryFlag[],
  global: readonly InventoryFlag[],
): InventoryFlag[] => {
  const byName = new Map<string, InventoryFlag>()
  for (const flag of [...global, ...local]) {
    byName.set(flag.name, flag)
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
}

const inventoryFromUsage = (spec: UsageJson): Inventory => {
  const rootFlags = spec.cmd.flags.filter((flag) => flag.hide !== true)
  const globalFlags = usageFlagInventory(
    rootFlags.filter((flag) => flag.global === true),
  )
  const rootLocalFlags = usageFlagInventory(
    rootFlags.filter((flag) => flag.global !== true),
  )
  const inventory: Inventory = {
    "": {
      args: usageArgInventory(spec.cmd.args),
      flags: mergeFlags(rootLocalFlags, globalFlags),
    },
  }
  for (const [name, command] of Object.entries(spec.cmd.subcommands)) {
    inventory[name] = {
      args: usageArgInventory(command.args),
      flags: mergeFlags(usageFlagInventory(command.flags), globalFlags),
    }
  }
  return inventory
}

const inventoryFromEffectHelp = (): Inventory => {
  const rootHelp = runEffectHelp(["--help"])
  const inventory: Inventory = {
    "": {
      args: parseHelpArgs(rootHelp),
      flags: mergeFlags(
        parseHelpFlags(rootHelp, "FLAGS"),
        parseHelpFlags(rootHelp, "GLOBAL FLAGS"),
      ),
    },
  }
  for (const name of parseHelpCommands(rootHelp)) {
    const help = runEffectHelp([name, "--help"])
    inventory[name] = {
      args: parseHelpArgs(help),
      flags: mergeFlags(
        parseHelpFlags(help, "FLAGS"),
        parseHelpFlags(help, "GLOBAL FLAGS"),
      ),
    }
  }
  return inventory
}

const namesOf = (inventory: Inventory): string[] =>
  Object.keys(inventory).sort()

const flagNames = (flags: readonly InventoryFlag[]): string[] =>
  flags.map((flag) => flag.name)

describe("operator CLI Usage contract", () => {
  test("pinned Usage 5.1.0 lints the contract with warnings as errors", () => {
    requireUsage510()
    const lint = runUsage(["lint", "--warnings-as-errors", usageSpecPath])
    expect(lint.status, `${lint.stdout}\n${lint.stderr}`).toBe(0)
  })

  test("contract metadata, effects, selectors, env, examples, and hidden switch", () => {
    const spec = usageJson()
    expect(spec.min_usage_version).toBe("5.1.0")
    expect(spec.about).toContain("write")
    expect(spec.about_long).toContain("NO_BROWSER")
    expect(spec.about_long).toContain("HOST")
    expect(spec.about_long).toContain("READY_FOR_AGENT_GRAPHQL_URL")
    expect(spec.cmd.mounts ?? []).toEqual([])
    expect(spec.complete ?? {}).toEqual({})

    const hidden = spec.cmd.flags.filter((flag) => flag.hide === true)
    expect(hidden.map((flag) => flag.name)).toEqual(["usage"])

    const publicRootFlags = spec.cmd.flags
      .filter((flag) => flag.hide !== true)
      .map((flag) => flag.name)
    expect(publicRootFlags).not.toContain("usage")
    expect(publicRootFlags).not.toContain("no-no-open")

    const effects = Object.fromEntries(
      PUBLIC_COMMANDS.map((name) => [name, spec.cmd.subcommands[name]?.effect]),
    )
    expect(effects).toEqual({
      start: "write",
      add: "write",
      candidates: "read",
      intake: "write",
      retry: "write",
      status: "read",
      jump: "destructive",
    })

    expect(spec.cmd.subcommands.add?.complete?.path?.type_).toBe("dir")
    expect(
      spec.cmd.subcommands.add?.flags.some((flag) => flag.name === "run"),
    ).toBe(false)

    const repositoryHelp = [
      spec.cmd.subcommands.candidates?.args[0]?.help,
      spec.cmd.subcommands.intake?.args[0]?.help,
      spec.cmd.subcommands.retry?.args[0]?.help,
      spec.cmd.subcommands.status?.args[0]?.help,
    ]
    for (const help of repositoryHelp) {
      expect(help).toBeDefined()
      for (const form of REPOSITORY_SELECTOR_FORMS) {
        expect(help).toContain(form)
      }
      expect(help?.toLowerCase()).toContain("case-insensitive")
    }

    const exampleCodes = [
      ...(spec.examples ?? []).map((example) => example.code),
      ...PUBLIC_COMMANDS.flatMap((name) =>
        (spec.cmd.subcommands[name]?.examples ?? []).map(
          (example) => example.code,
        ),
      ),
    ]
    expect(exampleCodes.some((code) => code === "ready-for-agent")).toBe(true)
    for (const name of PUBLIC_COMMANDS) {
      expect(
        exampleCodes.some((code) => code.startsWith(`ready-for-agent ${name}`)),
      ).toBe(true)
    }
    expect(exampleCodes.some((code) => code.includes("github.com://"))).toBe(
      true,
    )
    expect(
      exampleCodes.some((code) =>
        /ready-for-agent candidates owner\/repo$/.test(code),
      ),
    ).toBe(true)
    expect(
      exampleCodes.some((code) =>
        /ready-for-agent candidates repo$/.test(code),
      ),
    ).toBe(true)
    expect(
      exampleCodes.some((code) => code.startsWith("ready-for-agent jump ")),
    ).toBe(true)
  })

  test("Usage JSON and Effect help inventories match in both directions", () => {
    const spec = usageJson()
    const usageInventory = inventoryFromUsage(spec)
    const effectInventory = inventoryFromEffectHelp()

    expect(namesOf(usageInventory)).toEqual(namesOf(effectInventory))
    expect(namesOf(effectInventory)).toEqual([
      "",
      ...[...PUBLIC_COMMANDS].sort(),
    ])

    for (const command of namesOf(effectInventory)) {
      const usageCommand = usageInventory[command]
      const effectCommand = effectInventory[command]
      expect(usageCommand, command).toBeDefined()
      expect(effectCommand, command).toBeDefined()
      expect(usageCommand?.args, `${command} args`).toEqual(effectCommand?.args)
      expect(usageCommand?.flags, `${command} Usage flags`).toEqual(
        effectCommand?.flags,
      )
      expect(effectCommand?.flags, `${command} Effect flags`).toEqual(
        usageCommand?.flags,
      )
      expect(flagNames(usageCommand?.flags ?? [])).not.toContain("no-no-open")
      expect(flagNames(effectCommand?.flags ?? [])).not.toContain("usage")
    }

    const effectRootFlags = effectInventory[""]?.flags ?? []
    const completions = effectRootFlags.find(
      (flag) => flag.name === "completions",
    )
    const logLevel = effectRootFlags.find((flag) => flag.name === "log-level")
    expect(completions?.choices).toEqual(
      [...GLOBAL_FLAG_CHOICES.completions].sort(),
    )
    expect(logLevel?.choices).toEqual(
      [...GLOBAL_FLAG_CHOICES["log-level"]].sort(),
    )
    expect(
      effectRootFlags.find((flag) => flag.name === "help")?.aliases,
    ).toEqual(["h"])
    expect(
      effectRootFlags.find((flag) => flag.name === "version")?.aliases,
    ).toEqual(["v"])
  })

  test("hidden metadata and internal helper modes stay off public generated surfaces", () => {
    const markdown = runUsage(["generate", "markdown", "-f", usageSpecPath])
    expect(markdown.status, markdown.stderr).toBe(0)
    expect(markdown.stdout).not.toContain("--usage")
    expect(markdown.stdout).not.toContain("--no-no-open")
    for (const token of INTERNAL_TOKENS) {
      expect(markdown.stdout).not.toContain(token)
    }

    const rootWords = runUsage([
      "complete-word",
      "-f",
      usageSpecPath,
      "--",
      "ready-for-agent",
      "",
    ])
    expect(rootWords.status, rootWords.stderr).toBe(0)
    expect(rootWords.stdout.trim().split("\n").sort()).toEqual(
      [...PUBLIC_COMMANDS].sort(),
    )
    for (const token of INTERNAL_TOKENS) {
      expect(rootWords.stdout).not.toContain(token)
    }

    const rootFlags = runUsage([
      "complete-word",
      "-f",
      usageSpecPath,
      "--",
      "ready-for-agent",
      "--",
    ])
    expect(rootFlags.status, rootFlags.stderr).toBe(0)
    expect(rootFlags.stdout).toContain("--help")
    expect(rootFlags.stdout).toContain("--version")
    expect(rootFlags.stdout).toContain("--completions")
    expect(rootFlags.stdout).toContain("--log-level")
    expect(rootFlags.stdout).toContain("--no-open")
    expect(rootFlags.stdout).toContain("--host")
    expect(rootFlags.stdout).not.toContain("--usage")
    expect(rootFlags.stdout).not.toContain("--no-no-open")

    const tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-usage-"))
    try {
      writeFileSync(join(tempRoot, "notes.txt"), "file\n")
      mkdirSync(join(tempRoot, "repo-dir"))
      const addWords = runUsage(
        [
          "complete-word",
          "-f",
          usageSpecPath,
          "--",
          "ready-for-agent",
          "add",
          "",
        ],
        tempRoot,
      )
      expect(addWords.status, addWords.stderr).toBe(0)
      expect(addWords.stdout).toContain("repo-dir")
      expect(addWords.stdout).not.toContain("notes.txt")
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
