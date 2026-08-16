import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")
const defaultReadmePath = join(workspaceRoot, "README.md")
const usageSpecPath = join(appRoot, "ready-for-agent.usage.kdl")
const pinnedUsage = join(workspaceRoot, "scripts", "run-pinned-usage.sh")

const USAGE_START_MARKER = "<!-- usage:start -->"
const USAGE_END_MARKER = "<!-- usage:end -->"

export type CheckUsageDocsResult =
  | { readonly kind: "ok" }
  | { readonly kind: "stale" }
  | { readonly kind: "nondeterministic" }
  | { readonly kind: "missing-markers" }

const normalizeGeneratedMarkdown = (markdown: string): string =>
  markdown.endsWith("\n") ? markdown : `${markdown}\n`

export const generateCommandReference = (): string => {
  const result = spawnSync(
    "bash",
    [pinnedUsage, "generate", "markdown", "-f", usageSpecPath],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `Pinned Usage failed to generate markdown: ${result.stderr || result.stdout}`,
    )
  }
  return normalizeGeneratedMarkdown(result.stdout ?? "")
}

const markerBounds = (
  readme: string,
): { readonly start: number; readonly end: number } | undefined => {
  const start = readme.indexOf(USAGE_START_MARKER)
  const end = readme.indexOf(USAGE_END_MARKER)
  if (start < 0 || end < 0 || end <= start) {
    return undefined
  }
  return { start, end }
}

const extractManagedSection = (readme: string): string | undefined => {
  const bounds = markerBounds(readme)
  if (bounds === undefined) {
    return undefined
  }
  const afterStart = bounds.start + USAGE_START_MARKER.length
  const sectionStart = readme.startsWith("\n", afterStart)
    ? afterStart + 1
    : afterStart
  return readme.slice(sectionStart, bounds.end)
}

const injectManagedSection = (readme: string, generated: string): string => {
  const bounds = markerBounds(readme)
  if (bounds === undefined) {
    throw new Error(
      `README is missing ${USAGE_START_MARKER} / ${USAGE_END_MARKER} markers`,
    )
  }
  const section = normalizeGeneratedMarkdown(generated)
  return `${readme.slice(0, bounds.start)}${USAGE_START_MARKER}\n${section}${USAGE_END_MARKER}${readme.slice(bounds.end + USAGE_END_MARKER.length)}`
}

export const runUpdateUsageDocs = (input?: {
  readonly readmePath?: string
  readonly generate?: () => string
}): void => {
  const readmePath = input?.readmePath ?? defaultReadmePath
  const generate = input?.generate ?? generateCommandReference
  const next = injectManagedSection(
    readFileSync(readmePath, "utf8"),
    generate(),
  )
  writeFileSync(readmePath, next)
}

const writeTempGeneration = (directory: string, name: string, body: string) => {
  const path = join(directory, name)
  writeFileSync(path, body)
  return readFileSync(path)
}

export const runCheckUsageDocs = (input?: {
  readonly readmePath?: string
  readonly generate?: () => string
}): CheckUsageDocsResult => {
  const readmePath = input?.readmePath ?? defaultReadmePath
  const generate = input?.generate ?? generateCommandReference
  const tempRoot = mkdtempSync(join(tmpdir(), "ready-for-agent-usage-docs-"))
  try {
    const first = normalizeGeneratedMarkdown(generate())
    const second = normalizeGeneratedMarkdown(generate())
    const firstBytes = writeTempGeneration(tempRoot, "first.md", first)
    const secondBytes = writeTempGeneration(tempRoot, "second.md", second)
    if (!firstBytes.equals(secondBytes)) {
      return { kind: "nondeterministic" }
    }

    const checkedIn = extractManagedSection(readFileSync(readmePath, "utf8"))
    if (checkedIn === undefined) {
      return { kind: "missing-markers" }
    }
    if (!Buffer.from(checkedIn, "utf8").equals(firstBytes)) {
      return { kind: "stale" }
    }
    return { kind: "ok" }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

const checkMessage = (result: CheckUsageDocsResult): string => {
  switch (result.kind) {
    case "ok":
      return ""
    case "stale":
      return "Generated command reference is stale. Run `bunx nx run ready-for-agent:update-usage-docs`."
    case "nondeterministic":
      return "Generated command reference is nondeterministic."
    case "missing-markers":
      return `README is missing ${USAGE_START_MARKER} / ${USAGE_END_MARKER} markers`
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const unknown = args.filter((argument) => argument !== "--check")
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(", ")}`)
  }

  if (check) {
    const result = runCheckUsageDocs()
    if (result.kind !== "ok") {
      console.error(checkMessage(result))
      process.exitCode = 1
    }
  } else {
    runUpdateUsageDocs()
  }
}
