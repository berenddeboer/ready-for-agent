import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Result } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FpRequestError } from "../src/lib/errors.js"
import type { FpServiceShape } from "../src/lib/fp-service.js"
import { makeFpService } from "../src/lib/fp-service-live.js"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

/**
 * A fake `fp` executable in a temporary directory, the fake-CLI pattern the
 * Agent Backend suites use. It serves canned JSON per command from a
 * fixtures directory, records every invocation, and fails the way fp 0.25.0
 * fails when a marker file exists.
 */

const ISSUE_ID = (seed: string): string => seed.repeat(32).slice(0, 32)
const ROOT_A = ISSUE_ID("a")
const CHILD_B = ISSUE_ID("b")
const CHILD_C = ISSUE_ID("c")
const DONE_D = ISSUE_ID("d")
const ROOT_E = ISSUE_ID("e")
const CHILD_F = ISSUE_ID("f")
const SELECTED_G = ISSUE_ID("g")

type Fixture = {
  readonly id: string
  readonly shortId: string
  readonly title: string
  readonly status: string
  readonly parent: string | null
  readonly dependencies: readonly string[]
  readonly labels: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly author?: string | null
}

const fixture = (
  id: string,
  overrides: Partial<Fixture> & Pick<Fixture, "title" | "status">,
): Fixture => ({
  id,
  shortId: id.slice(0, 8),
  parent: null,
  dependencies: [],
  labels: [],
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-21T10:00:00.000Z",
  author: "operator@example.com",
  ...overrides,
})

const displayIdOf = (id: string): string => `FP-${id.slice(0, 8)}`

const PROJECT: readonly Fixture[] = [
  fixture(ROOT_A, {
    title: "Root A",
    status: "todo",
    labels: ["ready-for-agent", "epic"],
  }),
  fixture(CHILD_B, {
    title: "Child B",
    status: "todo",
    parent: ROOT_A,
    dependencies: [CHILD_C],
    labels: ["ready-for-agent"],
    createdAt: "2026-09-20T11:00:00.000Z",
  }),
  fixture(CHILD_C, {
    title: "Child C",
    status: "todo",
    parent: ROOT_A,
    createdAt: "2026-09-20T12:00:00.000Z",
  }),
  fixture(DONE_D, {
    title: "Done D",
    status: "done",
    labels: ["ready-for-agent"],
  }),
  fixture(ROOT_E, {
    title: "Root E",
    status: "todo",
    labels: ["ready-for-agent"],
    createdAt: "2026-09-20T10:30:00.000Z",
  }),
  fixture(CHILD_F, { title: "Child F", status: "todo", parent: ROOT_E }),
  fixture(SELECTED_G, {
    title: "Selected G",
    status: "selected",
    labels: ["ready-for-agent"],
    author: null,
    createdAt: "2026-09-20T10:45:00.000Z",
  }),
]

let directory = ""
let fixturesDirectory = ""
let commandPath = ""
let logPath = ""
let project = { projectDirectory: "" }

const writeProject = async (issues: readonly Fixture[]) => {
  await rm(fixturesDirectory, { recursive: true, force: true })
  await Bun.write(join(fixturesDirectory, ".keep"), "")
  const list = {
    issues: issues.map((issue) => ({
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      description: `Body of ${issue.title}`,
      status: issue.status,
      priority: "medium",
      parent: issue.parent,
      dependencies: issue.dependencies,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    })),
  }
  await writeFile(join(fixturesDirectory, "list.json"), JSON.stringify(list))
  for (const issue of issues) {
    const show = {
      id: issue.id,
      displayId: displayIdOf(issue.id),
      title: issue.title,
      description: `Body of ${issue.title}`,
      status: issue.status,
      priority: "medium",
      parent: issue.parent,
      dependencies: issue.dependencies,
      revisions: [],
      author: issue.author,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      properties: { labels: issue.labels },
      comments: [],
    }
    const json = JSON.stringify(show)
    // fp accepts the native id and the display id alike.
    await writeFile(join(fixturesDirectory, `show-${issue.id}.json`), json)
    await writeFile(
      join(fixturesDirectory, `show-${displayIdOf(issue.id)}.json`),
      json,
    )
  }
}

const marker = (name: string) => writeFile(join(fixturesDirectory, name), "")

const fakeFpScript = (fixtures: string, log: string): string => `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ -f "${fixtures}/hang" ]; then sleep 30; exit 0; fi
if [ -f "${fixtures}/crash" ]; then kill -9 $$; fi
if [ "$1" = "--version" ]; then echo "0.25.0 (d818046)"; exit 0; fi
if [ "$1" = "auth" ]; then
  printf '%s\\n' "✓ Token valid" "" "  Source: /home/op/.fiberplane/credentials.toml" "  Token: abc..." "" "  Name: Operator" "  Email: operator@example.com" ""
  exit 0
fi
if [ "$1" = "project" ] && [ "$2" = "remote" ]; then
  if [ -f "${fixtures}/unlinked" ]; then
    printf '%s\\n' "Project not linked to remote" "  Suggestion: No local project is registered here and no remote identity was found."
    exit 1
  fi
  printf '%s\\n' "Remote Project" "  Project ID:    proj-test" "  Workspace:     ws-test" "  Server URL:    https://app.fp.dev"
  exit 0
fi
if [ -f "${fixtures}/unregistered" ]; then
  printf '%s\\n' ".fp directory not found" "  Suggestion: Run 'fp init' to initialize a project"
  exit 1
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then cat "${fixtures}/list.json"; exit 0; fi
if [ "$1" = "issue" ] && [ "$2" = "show" ]; then
  if [ -f "${fixtures}/malformed" ]; then echo "{not json"; exit 0; fi
  f="${fixtures}/show-$3.json"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  printf '%s\\n' "Issue $3 not found" "  Suggestion: Run 'fp issue list' to see available issues"
  exit 1
fi
echo "Unknown arguments: $*" >&2
exit 1
`

const linkFor = (nativeId: string): string =>
  `fp://issue?workspace=ws-test&project=proj-test&id=${nativeId}`

const calls = async (): Promise<readonly string[]> => {
  try {
    const text = await readFile(logPath, "utf8")
    return text.split("\n").filter((line) => line !== "")
  } catch {
    return []
  }
}

const showCalls = async (): Promise<number> =>
  (await calls()).filter((line) => line.startsWith("issue show ")).length

type ServiceOverrides = {
  readonly command?: string
  readonly timeout?: Duration.Duration
}

const makeService = (overrides: ServiceOverrides = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return makeFpService({
      spawner,
      command: overrides.command ?? commandPath,
      ...(overrides.timeout === undefined
        ? {}
        : { timeout: overrides.timeout }),
    })
  }).pipe(Effect.provide(BunServices.layer))

const withService = <A, E>(
  use: (service: FpServiceShape) => Effect.Effect<A, E>,
  overrides: ServiceOverrides = {},
) => Effect.flatMap(makeService(overrides), use)

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const failureOf = async <A>(
  effect: Effect.Effect<A, FpRequestError>,
): Promise<FpRequestError> => {
  const result = await run(effect.pipe(Effect.result))
  if (Result.isSuccess(result)) {
    throw new Error("expected a failure")
  }
  expect(result.failure).toBeInstanceOf(FpRequestError)
  return result.failure
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "fp-service-"))
  fixturesDirectory = join(directory, "fixtures")
  commandPath = join(directory, "fp")
  logPath = join(directory, "calls.log")
  project = { projectDirectory: directory }
  await writeFile(commandPath, fakeFpScript(fixturesDirectory, logPath))
  await chmod(commandPath, 0o700)
})

beforeEach(async () => {
  await rm(logPath, { force: true })
  await writeProject(PROJECT)
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("FpService.listReadyIssues", () => {
  test("returns open Ready-labeled Issues in creation order with hierarchy and blocker facts", async () => {
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues.map((issue) => issue.title)).toEqual([
      "Root A",
      "Root E",
      "Selected G",
      "Child B",
    ])

    const rootA = issues[0]
    expect(rootA?.nativeId).toBe(ROOT_A)
    expect(rootA?.displayId).toBe(displayIdOf(ROOT_A))
    expect(rootA?.url).toBe(linkFor(ROOT_A))
    expect(rootA?.state).toBe("OPEN")
    expect(rootA?.parent).toBeNull()
    expect(rootA?.parentPosition).toBeNull()
    expect(rootA?.hasChildren).toBe(true)
    expect(rootA?.hierarchySupported).toBe(true)
    expect(rootA?.author).toBe("operator@example.com")
    expect(rootA?.body).toBe("Body of Root A")
    expect(rootA?.labels).toEqual(["ready-for-agent", "epic"])

    const childB = issues[3]
    expect(childB?.parent).toEqual({
      nativeId: ROOT_A,
      displayId: displayIdOf(ROOT_A),
      url: linkFor(ROOT_A),
      state: "OPEN",
      isReadyLabeled: true,
    })
    // B was created before C among A's children.
    expect(childB?.parentPosition).toBe(1)
    expect(childB?.hasChildren).toBe(false)
    expect(childB?.blockedBy).toEqual([
      {
        nativeId: CHILD_C,
        displayId: displayIdOf(CHILD_C),
        url: linkFor(CHILD_C),
      },
    ])

    // E has a child (unlabeled F), so it is a parent, not a leaf.
    expect(issues[1]?.hasChildren).toBe(true)
    // G has no author in fp.
    expect(issues[2]?.author).toBeNull()
    expect(issues[2]?.status).toBe("selected")
  })

  test("a closed Issue is never a candidate, even when labeled", async () => {
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues.some((issue) => issue.nativeId === DONE_D)).toBe(false)
    const shown = await calls()
    expect(shown.some((line) => line.includes(DONE_D))).toBe(false)
  })

  test("closedStatuses is the project's own closed set", async () => {
    const issues = await run(
      withService((service) =>
        service.listReadyIssues({
          ...project,
          closedStatuses: ["done", "selected"],
        }),
      ),
    )
    expect(issues.map((issue) => issue.title)).toEqual([
      "Root A",
      "Root E",
      "Child B",
    ])
  })

  test("inspects only open Issues, and only once per poll", async () => {
    await run(withService((service) => service.listReadyIssues(project)))
    // Six open Issues (A, B, C, E, F, G); their parents are candidates too,
    // so no extra show is needed for them.
    expect(await showCalls()).toBe(6)
  })

  test("a Ready child of a closed parent reports the parent closed, at the cost of one extra show", async () => {
    const CHILD_H = ISSUE_ID("h")
    await writeProject([
      ...PROJECT,
      fixture(CHILD_H, {
        title: "Child H",
        status: "todo",
        parent: DONE_D,
        labels: ["ready-for-agent"],
      }),
    ])
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    const childH = issues.find((issue) => issue.title === "Child H")
    expect(childH?.parent).toEqual({
      nativeId: DONE_D,
      displayId: displayIdOf(DONE_D),
      url: linkFor(DONE_D),
      state: "CLOSED",
      isReadyLabeled: true,
    })
    expect(childH?.parentPosition).toBe(1)
    // Seven open candidates plus the closed parent D.
    expect(await showCalls()).toBe(8)
  })

  test("candidateStatuses narrows the inspection to those statuses", async () => {
    const issues = await run(
      withService((service) =>
        service.listReadyIssues({
          ...project,
          candidateStatuses: ["selected"],
        }),
      ),
    )
    expect(issues.map((issue) => issue.title)).toEqual(["Selected G"])
    expect(await showCalls()).toBe(1)
  })

  test("re-reads only Issues whose updatedAt moved since the last poll", async () => {
    const service = await run(makeService())
    const first = await run(service.listReadyIssues(project))
    expect(first).toHaveLength(4)
    expect(await showCalls()).toBe(6)

    await rm(logPath, { force: true })
    const second = await run(service.listReadyIssues(project))
    expect(second).toEqual(first)
    expect(await showCalls()).toBe(0)

    // Removing the label bumps updatedAt in fp; only that Issue is re-read.
    await rm(logPath, { force: true })
    await writeProject(
      PROJECT.map((issue) =>
        issue.id === ROOT_E
          ? { ...issue, labels: [], updatedAt: "2026-09-22T09:00:00.000Z" }
          : issue,
      ),
    )
    const third = await run(service.listReadyIssues(project))
    expect(third.map((issue) => issue.title)).toEqual([
      "Root A",
      "Selected G",
      "Child B",
    ])
    expect(await showCalls()).toBe(1)
  })

  test("reads the remote identity once per project, not once per poll", async () => {
    const service = await run(makeService())
    await run(service.listReadyIssues(project))
    await run(service.listReadyIssues(project))
    const remoteCalls = (await calls()).filter((line) =>
      line.startsWith("project remote"),
    )
    expect(remoteCalls).toHaveLength(1)
  })

  test("links by id only when the project is not linked to a remote", async () => {
    await marker("unlinked")
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues[0]?.url).toBe(`fp://issue?id=${ROOT_A}`)
    expect(issues[3]?.parent?.url).toBe(`fp://issue?id=${ROOT_A}`)
  })

  test("an Issue that vanishes between list and show is dropped, not fatal", async () => {
    await rm(join(fixturesDirectory, `show-${ROOT_E}.json`))
    await rm(join(fixturesDirectory, `show-${displayIdOf(ROOT_E)}.json`))
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(issues.map((issue) => issue.title)).toEqual([
      "Root A",
      "Selected G",
      "Child B",
    ])
  })

  test("a child whose parent is missing from the project is reported under a closed, unready parent", async () => {
    await writeProject([
      ...PROJECT,
      fixture(ISSUE_ID("h"), {
        title: "Orphan H",
        status: "todo",
        parent: ISSUE_ID("z"),
        labels: ["ready-for-agent"],
      }),
    ])
    const issues = await run(
      withService((service) => service.listReadyIssues(project)),
    )
    const orphan = issues.find((issue) => issue.title === "Orphan H")
    expect(orphan?.parent).toEqual({
      nativeId: ISSUE_ID("z"),
      displayId: ISSUE_ID("z"),
      url: linkFor(ISSUE_ID("z")),
      state: "CLOSED",
      isReadyLabeled: false,
    })
    expect(orphan?.parentPosition).toBeNull()
  })

  test("fails with a clear message when the directory is not an fp project", async () => {
    await marker("unregistered")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(failure.message).toContain("not a registered fp project")
    expect(failure.exitCode).toBe(1)
    expect(failure.kind).toBe("project_not_registered")
  })

  test("fails with a clear message when the fp CLI is absent", async () => {
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project), {
        command: join(directory, "no-such-fp"),
      }),
    )
    expect(failure.message).toContain("the fp CLI is not on the PATH")
    expect(failure.kind).toBe("spawn_failed")
  })

  test("fails with a clear message when fp does not finish in time", async () => {
    await marker("hang")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project), {
        timeout: Duration.millis(300),
      }),
    )
    expect(failure.message).toContain("did not finish within 300 ms")
    expect(failure.kind).toBe("timeout")
  })

  test("fails with a clear message when fp dies by signal", async () => {
    await marker("crash")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(failure.message).not.toContain("not on the PATH")
    expect(failure.message).toContain("failed before exiting")
  })

  test("fails with a clear message when fp prints unreadable JSON", async () => {
    await marker("malformed")
    const failure = await failureOf(
      withService((service) => service.listReadyIssues(project)),
    )
    expect(failure.message).toContain(
      "Could not read fp output while reading fp issue",
    )
    expect(failure.kind).toBe("unreadable_output")
  })
})

describe("FpService.getIssue", () => {
  test("returns the live snapshot by native id", async () => {
    const snapshot = await run(
      withService((service) => service.getIssue(project, DONE_D)),
    )
    expect(snapshot).toEqual({
      nativeId: DONE_D,
      displayId: displayIdOf(DONE_D),
      url: linkFor(DONE_D),
      status: "done",
      state: "CLOSED",
      labels: ["ready-for-agent"],
    })
  })

  test("returns the live snapshot by display id", async () => {
    const snapshot = await run(
      withService((service) => service.getIssue(project, displayIdOf(ROOT_A))),
    )
    expect(snapshot.nativeId).toBe(ROOT_A)
    expect(snapshot.state).toBe("OPEN")
  })

  test("uses the project's closed statuses", async () => {
    const snapshot = await run(
      withService((service) =>
        service.getIssue(
          { ...project, closedStatuses: ["selected"] },
          SELECTED_G,
        ),
      ),
    )
    expect(snapshot.state).toBe("CLOSED")
  })

  test("fails for an unknown Issue", async () => {
    const failure = await failureOf(
      withService((service) => service.getIssue(project, "FP-nope")),
    )
    expect(failure.message).toContain("the Issue does not exist")
    expect(failure.kind).toBe("issue_not_found")
  })
})

describe("FpService.getAuthenticatedUserLogin", () => {
  test("returns the fp account email as the operator identity", async () => {
    const login = await run(
      withService((service) => service.getAuthenticatedUserLogin(directory)),
    )
    expect(login).toBe("operator@example.com")
  })
})

describe("FpService.checkReadiness", () => {
  test("is ready when the CLI runs and the project resolves", async () => {
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness).toEqual({
      _tag: "ready",
      version: "0.25.0",
      remote: { workspaceSlug: "ws-test", projectId: "proj-test" },
    })
  })

  test("is ready without a remote for a local-only project, so callers can warn that links will not open", async () => {
    await marker("unlinked")
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness).toEqual({
      _tag: "ready",
      version: "0.25.0",
      remote: null,
    })
  })

  test("reports a missing CLI", async () => {
    const readiness = await run(
      withService((service) => service.checkReadiness(directory), {
        command: join(directory, "no-such-fp"),
      }),
    )
    expect(readiness._tag).toBe("cli_missing")
  })

  test("reports a directory that does not exist, without blaming the CLI", async () => {
    const readiness = await run(
      withService((service) =>
        service.checkReadiness(join(directory, "no-such-dir")),
      ),
    )
    expect(readiness._tag).toBe("project_not_registered")
    if (readiness._tag === "project_not_registered") {
      expect(readiness.message).toContain("does not exist")
    }
  })

  test("reports an unregistered project directory", async () => {
    await marker("unregistered")
    const readiness = await run(
      withService((service) => service.checkReadiness(directory)),
    )
    expect(readiness._tag).toBe("project_not_registered")
  })
})
