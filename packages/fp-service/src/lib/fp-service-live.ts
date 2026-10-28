import { access } from "node:fs/promises"
import { Duration, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FpRequestError } from "./errors.js"
import {
  type FpListIssue,
  type FpShowIssue,
  classifyFpFailure,
  fpIssueLabels,
  parseFpAuthStatus,
  parseFpIssueList,
  parseFpIssueShow,
  parseFpProjectRemote,
  parseFpVersion,
} from "./fp-cli-output.js"
import { FpService, type FpServiceShape } from "./fp-service.js"
import {
  FP_CLI_COMMAND,
  FP_READY_LABEL,
  type FpIssue,
  type FpIssueParent,
  type FpIssueReference,
  type FpIssueSnapshot,
  type FpProjectOptions,
  fpIssueState,
  fpIssueUrl,
} from "./types.js"

export const FP_CLI_TIMEOUT = Duration.seconds(60)
/** Grace after SIGTERM before a timed-out fp is killed outright. */
export const FP_FORCE_KILL_AFTER = Duration.seconds(5)
/** `fp issue show` is one process per Issue; eight at once keeps a poll short. */
export const FP_SHOW_CONCURRENCY = 8

export interface MakeFpServiceOptions {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  /** Executable name or path; defaults to `fp` on the PATH. */
  readonly command?: string
  readonly timeout?: Duration.Duration
}

interface FpCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Cached `show` output, valid while the Issue's list `updatedAt` is unchanged. */
interface ShowCacheEntry {
  readonly updatedAt: string
  readonly issue: FpShowIssue
}

const requestError = (
  message: string,
  extra?: Partial<FpCliResult> & { readonly kind?: FpRequestError["kind"] },
  cause?: unknown,
): FpRequestError =>
  new FpRequestError({
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(extra?.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
    ...(extra?.stderr === undefined || extra.stderr === ""
      ? {}
      : { stderr: extra.stderr }),
    ...(extra?.kind === undefined ? {} : { kind: extra.kind }),
  })

const combinedOutput = (result: FpCliResult): string =>
  `${result.stdout}\n${result.stderr}`

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * A missing executable or working directory: Effect's spawner reports it as
 * `NotFound`, Node's underlying error as `ENOENT`.
 */
const isMissingPath = (cause: unknown): boolean =>
  /ENOENT|NotFound/.test(causeMessage(cause))

const directoryExists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => access(path)).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  )

/**
 * Every operation spawns the fp CLI with the project directory as working
 * directory. One cache lives as long as the service: `show` output keyed by
 * the list's `updatedAt`, so a poll re-reads only what changed, pruned to
 * the Issues the list still has. The project's remote identity is read on
 * every poll so a link change takes effect without a restart.
 */
export const makeFpService = (
  options: MakeFpServiceOptions,
): FpServiceShape => {
  const command = options.command ?? FP_CLI_COMMAND
  const timeout = options.timeout ?? FP_CLI_TIMEOUT
  const showCache = new Map<string, ShowCacheEntry>()

  const runFp = Effect.fn("FpService.runFp")(function* (
    cwd: string,
    args: readonly string[],
  ) {
    const process = ChildProcess.make(command, [...args], {
      cwd,
      stdin: "ignore",
      // On timeout the scope's release sends SIGTERM to the process group;
      // an fp that ignores it is killed rather than holding the poll.
      forceKillAfter: FP_FORCE_KILL_AFTER,
    })
    const invocation = `${command} ${args.join(" ")}`
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* options.spawner.spawn(process)
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          ],
          { concurrency: 3 },
        )
        return {
          exitCode: Number(exitCode),
          stdout,
          stderr,
        } satisfies FpCliResult
      }),
    ).pipe(
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          requestError(
            `${invocation} did not finish within ${Duration.toMillis(timeout)} ms in ${cwd}.`,
            { kind: "timeout" },
          ),
        ),
      ),
      Effect.catch((error) => {
        if (error instanceof FpRequestError) {
          return Effect.fail(error)
        }
        // A missing executable and a missing working directory both surface
        // as ENOENT; the readiness check tells them apart, this message
        // names both so the operator is not sent to install fp for a typo
        // in the directory.
        const message = isMissingPath(error)
          ? `Could not run ${invocation}: the fp CLI is not on the PATH, or ${cwd} does not exist.`
          : `${invocation} failed before exiting in ${cwd}: ${causeMessage(error)}`
        return Effect.fail(
          requestError(
            message,
            { kind: isMissingPath(error) ? "spawn_failed" : "unknown" },
            error,
          ),
        )
      }),
    )
  })

  /** Run fp and require exit code 0, or fail with the classified message. */
  const runFpOk = Effect.fn("FpService.runFpOk")(function* (
    cwd: string,
    args: readonly string[],
    describe: string,
  ) {
    const result = yield* runFp(cwd, args)
    if (result.exitCode !== 0) {
      const kind = classifyFpFailure(combinedOutput(result))
      const detail =
        kind === "project_not_registered"
          ? `${cwd} is not a registered fp project`
          : kind === "issue_not_found"
            ? "the Issue does not exist"
            : kind === "invalid_status"
              ? "the status is not registered in this fp project"
              : `fp exited with code ${result.exitCode}`
      return yield* requestError(`Failed ${describe}: ${detail}.`, {
        ...result,
        kind,
      })
    }
    return result
  })

  const parseOrFail = <A>(
    describe: string,
    result: FpCliResult,
    parse: (stdout: string) => A,
  ): Effect.Effect<A, FpRequestError> =>
    Effect.try({
      try: () => parse(result.stdout),
      catch: (cause) =>
        requestError(
          `Could not read fp output while ${describe}.`,
          { ...result, kind: "unreadable_output" },
          cause,
        ),
    })

  const listIssues = Effect.fn("FpService.listIssues")(function* (cwd: string) {
    const describe = "listing fp issues"
    const result = yield* runFpOk(
      cwd,
      ["issue", "list", "--format", "json"],
      describe,
    )
    return yield* parseOrFail(describe, result, parseFpIssueList)
  })

  const showIssue = Effect.fn("FpService.showIssue")(function* (
    cwd: string,
    issueId: string,
  ) {
    const describe = `reading fp issue ${issueId}`
    const result = yield* runFpOk(
      cwd,
      ["issue", "show", issueId, "--format", "json"],
      describe,
    )
    return yield* parseOrFail(describe, result, parseFpIssueShow)
  })

  /**
   * The project's remote identity, read on every call: one short process
   * per poll, so linking, unlinking or relinking the project takes effect
   * on the next poll without a restart. An unlinked project (exit 1,
   * "Project not linked to remote") reads as null; any other failure is an
   * error, not "unlinked".
   */
  const projectRemote = Effect.fn("FpService.projectRemote")(function* (
    cwd: string,
  ) {
    const describe = "reading the fp project's remote identity"
    const result = yield* runFp(cwd, ["project", "remote", "--format", "json"])
    if (result.exitCode !== 0) {
      if (/not linked to remote/i.test(combinedOutput(result))) {
        return null
      }
      return yield* requestError(
        `Failed ${describe}: fp exited with code ${result.exitCode}.`,
        { ...result, kind: classifyFpFailure(combinedOutput(result)) },
      )
    }
    return yield* parseOrFail(describe, result, parseFpProjectRemote)
  })

  /**
   * `show`, served from the cache while the list's `updatedAt` matches. fp
   * 0.25.0 moves `updatedAt` on every edit that matters here: a label,
   * parent or dependency change and a comment (measured 2026-09-22), so an
   * unchanged `updatedAt` means unchanged labels. Null when the Issue
   * vanished between list and show; that one Issue is dropped from the poll
   * instead of failing discovery for every other one.
   */
  const showCached = Effect.fn("FpService.showCached")(function* (
    cwd: string,
    listed: FpListIssue,
  ) {
    const cached = showCache.get(listed.id)
    if (cached !== undefined && cached.updatedAt === listed.updatedAt) {
      return cached.issue
    }
    const issue = yield* showIssue(cwd, listed.id).pipe(
      Effect.catch((error) =>
        error.kind === "issue_not_found"
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    )
    if (issue !== null) {
      showCache.set(listed.id, { updatedAt: listed.updatedAt, issue })
    }
    return issue
  })

  const listReadyIssues = Effect.fn("FpService.listReadyIssues")(function* (
    projectOptions: FpProjectOptions,
  ) {
    const cwd = projectOptions.projectDirectory
    const readyLabel = projectOptions.readyLabel ?? FP_READY_LABEL
    const stateOf = (status: string) => fpIssueState(status, projectOptions)
    const remote = yield* projectRemote(cwd)

    // One list call gives status, parent, dependencies and updatedAt for
    // every Issue; hierarchy and blocker facts come from here, never from
    // extra show calls.
    const all = yield* listIssues(cwd)
    const byId = new Map(all.map((issue) => [issue.id, issue]))
    const childrenOf = new Map<string, FpListIssue[]>()
    for (const issue of all) {
      if (issue.parent !== null && issue.parent !== undefined) {
        const siblings = childrenOf.get(issue.parent) ?? []
        siblings.push(issue)
        childrenOf.set(issue.parent, siblings)
      }
    }

    const candidateStatuses =
      projectOptions.candidateStatuses === undefined
        ? null
        : new Set(projectOptions.candidateStatuses)
    const candidates = all.filter(
      (issue) =>
        stateOf(issue.status) === "OPEN" &&
        (candidateStatuses === null || candidateStatuses.has(issue.status)),
    )

    // Labels are only visible through show; inspect each candidate, cached
    // by updatedAt so an unchanged Issue costs nothing on the next poll.
    // Only the labels, title, body and author come from show; parent and
    // dependencies are taken from this poll's list entry.
    const shown = yield* Effect.forEach(
      candidates,
      (listed) => showCached(cwd, listed),
      { concurrency: FP_SHOW_CONCURRENCY },
    )
    // Issues that left the project take their cached show with them.
    for (const cachedId of [...showCache.keys()]) {
      if (!byId.has(cachedId)) {
        showCache.delete(cachedId)
      }
    }
    const ready = candidates.flatMap((listed, index) => {
      const issue = shown[index]
      return issue !== undefined &&
        issue !== null &&
        fpIssueLabels(issue).includes(readyLabel)
        ? [{ listed, issue }]
        : []
    })

    // A reference to an Issue we did not show (a blocker, an absent parent)
    // gets its display id from the cache when we have shown it before, else
    // from the project prefix: the display id is `<prefix>-<shortId>`, and
    // the prefix is what a shown Issue's display id has before its own
    // short id (a prefix may itself contain a dash).
    const prefix = (() => {
      const sample = ready[0]
      if (sample === undefined) {
        return null
      }
      const suffix = `-${sample.listed.shortId}`
      return sample.issue.displayId.endsWith(suffix)
        ? sample.issue.displayId.slice(0, -suffix.length)
        : null
    })()
    const referenceFor = (nativeId: string): FpIssueReference => {
      const cachedDisplayId = showCache.get(nativeId)?.issue.displayId
      const listed = byId.get(nativeId)
      const displayId =
        cachedDisplayId ??
        (listed !== undefined && prefix !== null
          ? `${prefix}-${listed.shortId}`
          : nativeId)
      return { nativeId, displayId, url: fpIssueUrl(remote, nativeId) }
    }

    const parentFor = Effect.fn("FpService.parentFor")(function* (
      issue: FpListIssue,
    ) {
      const parentId = issue.parent
      if (parentId === null || parentId === undefined) {
        return { parent: null, parentPosition: null }
      }
      const listedParent = byId.get(parentId)
      // A parent outside this project's list (deleted, foreign) or one that
      // vanished mid-poll counts as closed and not Ready, so the child is
      // not offered.
      const shownParent =
        listedParent === undefined ? null : yield* showCached(cwd, listedParent)
      if (listedParent === undefined || shownParent === null) {
        const parent: FpIssueParent = {
          ...referenceFor(parentId),
          state: "CLOSED",
          isReadyLabeled: false,
        }
        return { parent, parentPosition: null }
      }
      const parent: FpIssueParent = {
        nativeId: parentId,
        displayId: shownParent.displayId,
        url: fpIssueUrl(remote, parentId),
        state: stateOf(listedParent.status),
        isReadyLabeled: fpIssueLabels(shownParent).includes(readyLabel),
      }
      const siblings = [...(childrenOf.get(parentId) ?? [])].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      )
      const index = siblings.findIndex((sibling) => sibling.id === issue.id)
      return { parent, parentPosition: index === -1 ? null : index + 1 }
    })

    const issues: FpIssue[] = []
    for (const { listed, issue } of ready) {
      const { parent, parentPosition } = yield* parentFor(listed)
      issues.push({
        nativeId: issue.id,
        displayId: issue.displayId,
        title: issue.title,
        body: issue.description ?? "",
        url: fpIssueUrl(remote, issue.id),
        createdAt: new Date(listed.createdAt),
        updatedAt: new Date(listed.updatedAt),
        status: listed.status,
        state: stateOf(listed.status),
        author: issue.author ?? null,
        labels: fpIssueLabels(issue),
        parent,
        parentPosition,
        hasChildren: (childrenOf.get(issue.id)?.length ?? 0) > 0,
        hierarchySupported: true,
        blockedBy: (listed.dependencies ?? []).map(referenceFor),
      })
    }
    // fp short ids are random letters, so creation order is the meaningful
    // order; the display id only breaks ties deterministically.
    return issues.sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.displayId.localeCompare(right.displayId),
    )
  })

  const getIssue = Effect.fn("FpService.getIssue")(function* (
    projectOptions: FpProjectOptions,
    issueId: string,
  ) {
    const issue = yield* showIssue(projectOptions.projectDirectory, issueId)
    const remote = yield* projectRemote(projectOptions.projectDirectory)
    const snapshot: FpIssueSnapshot = {
      nativeId: issue.id,
      displayId: issue.displayId,
      url: fpIssueUrl(remote, issue.id),
      status: issue.status,
      state: fpIssueState(issue.status, projectOptions),
      labels: fpIssueLabels(issue),
    }
    return snapshot
  })

  const getAuthenticatedUserLogin = Effect.fn(
    "FpService.getAuthenticatedUserLogin",
  )(function* (projectDirectory: string) {
    const result = yield* runFp(projectDirectory, ["auth", "status"])
    const operator = parseFpAuthStatus(combinedOutput(result))
    if (result.exitCode !== 0 || operator === null) {
      return yield* requestError(
        "fp is not authenticated on this machine; run `fp auth login` as the operator.",
        result,
      )
    }
    return operator.email
  })

  const checkReadiness = Effect.fn("FpService.checkReadiness")(function* (
    projectDirectory: string,
  ) {
    if (!(yield* directoryExists(projectDirectory))) {
      return {
        _tag: "project_not_registered" as const,
        message: `${projectDirectory} does not exist.`,
      }
    }
    const version = yield* runFp(projectDirectory, ["--version"]).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? parseFpVersion(result.stdout) : null,
      ),
      Effect.orElseSucceed(() => null),
    )
    if (version === null) {
      return {
        _tag: "cli_missing" as const,
        message: `The fp CLI is not available as \`${command}\`; install it and make sure it is on the PATH.`,
      }
    }
    // The CLI runs, so a probe that hangs, dies or fails for another reason
    // is an fp problem, not an unregistered directory.
    const probe = yield* runFp(projectDirectory, [
      "issue",
      "list",
      "--format",
      "json",
      "--limit",
      "1",
    ]).pipe(
      Effect.map((result) => ({ _tag: "exited" as const, result })),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "failed" as const, error }),
      ),
    )
    if (probe._tag === "failed") {
      return { _tag: "cli_error" as const, message: probe.error.message }
    }
    if (probe.result.exitCode !== 0) {
      if (
        classifyFpFailure(combinedOutput(probe.result)) ===
        "project_not_registered"
      ) {
        return {
          _tag: "project_not_registered" as const,
          message: `${projectDirectory} is not a registered fp project (run \`fp init\` there, or configure the fp project directory).`,
        }
      }
      return {
        _tag: "cli_error" as const,
        message: `fp could not list issues in ${projectDirectory} (exit code ${probe.result.exitCode}): ${combinedOutput(probe.result).trim()}`,
      }
    }
    // Readiness never fails; a remote lookup that errors is reported as such,
    // not as an unlinked project.
    const remote = yield* projectRemote(projectDirectory).pipe(
      Effect.map((value) => ({ _tag: "known" as const, value })),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "failed" as const, message: error.message }),
      ),
    )
    if (remote._tag === "failed") {
      return { _tag: "cli_error" as const, message: remote.message }
    }
    return { _tag: "ready" as const, version, remote: remote.value }
  })

  return {
    getAuthenticatedUserLogin,
    listReadyIssues,
    getIssue,
    checkReadiness,
  } satisfies FpServiceShape
}

/** Live layer: spawns the `fp` CLI through the platform's process spawner. */
export const FpServiceLive = Layer.effect(
  FpService,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return makeFpService({ spawner })
  }),
)
