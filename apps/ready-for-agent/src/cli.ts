import { Console, Effect, FileSystem, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  FiniteCommandFailed,
  type FiniteCommandName,
  buildAddSuccessDocument,
  buildCandidatesSuccessDocument,
  buildIntakeSuccessDocument,
  buildStatusSuccessDocument,
  encodeCompactJson,
  intakeHasFailedResults,
  localGitErrorCode,
  toCanonicalRepositoryIdentity,
} from "./cli-json.ts"
import { interactiveResumeCommand } from "./interactive-resume.ts"
import { JumpFailed } from "./jump-error.ts"
import {
  type RepositoryIdentityFields,
  type RepositoryIdentityMatch,
  formatRepositoryFullIdentity,
  resolveRepositoryIdentity,
} from "./repository-identity.ts"
import { DirectTerminal } from "./services/direct-terminal.ts"
import { ExecutablePath } from "./services/executable-path.ts"
import { GraphqlApi } from "./services/graphql-api.ts"
import { LocalGit } from "./services/local-git.ts"
import { StartHarness } from "./services/start-harness.ts"
import { Tmux } from "./services/tmux.ts"

const pathArg = Argument.string("path").pipe(
  Argument.withDescription("Path to a local git repository"),
)

const repositorySelectorGuidance =
  "Use <forge-host>://<project-path>, <forge-host>/<project-path>, a unique project path, or a unique final project-path segment"

const repositoryIdentityArg = Argument.string("repository").pipe(
  Argument.withDescription(
    "Repository identity as <forge-host>://<project-path>, <forge-host>/<project-path>, a unique project path, or a unique final project-path segment (case-insensitive)",
  ),
)

const sessionIdArg = Argument.string("session-id").pipe(
  Argument.withDescription("Opaque backend Session ID to continue"),
)

const optionalRepositoryIdentityArg = Argument.string("repository").pipe(
  Argument.withDescription(
    "Optional repository identity as <forge-host>://<project-path>, <forge-host>/<project-path>, a unique project path, or a unique final project-path segment (case-insensitive)",
  ),
  Argument.optional,
)

const noOpenFlag = Flag.boolean("no-open").pipe(
  Flag.withDescription(
    "Do not open the default browser after a successful start (also: NO_BROWSER)",
  ),
)

const hostFlag = Flag.string("host").pipe(
  Flag.withDescription(
    "Listen host (default 127.0.0.1). Bare --host binds all interfaces (0.0.0.0); --host <addr> binds that address. Env: HOST (flag wins)",
  ),
  Flag.optional,
)

const forgeHostFlag = Flag.string("forge-host").pipe(
  Flag.withDescription(
    "Correct the forge host inferred from the repository remote",
  ),
  Flag.optional,
)

const projectPathFlag = Flag.string("project-path").pipe(
  Flag.withDescription(
    "Correct the forge project path inferred from the repository remote",
  ),
  Flag.optional,
)

const startHarnessWorkflow = Effect.fn("Cli.startHarness")(function* (
  noOpen: boolean,
  host: string | undefined,
) {
  const startHarnessService = yield* StartHarness
  yield* startHarnessService.start({ noOpen, host })
})

const repositoryIdentityCommandFailed = (
  command: FiniteCommandName,
  resolved: Exclude<
    RepositoryIdentityMatch<RepositoryIdentityFields>,
    { readonly _tag: "matched" }
  >,
): FiniteCommandFailed => {
  switch (resolved._tag) {
    case "invalid":
      return new FiniteCommandFailed({
        command,
        code: "REPOSITORY_NOT_FOUND",
        message: `Invalid repository identity "${resolved.argument}". ${repositorySelectorGuidance}.`,
      })
    case "not_found":
      return new FiniteCommandFailed({
        command,
        code: "REPOSITORY_NOT_FOUND",
        message: `No configured Repository matches ${resolved.selector}`,
      })
    case "ambiguous":
      return new FiniteCommandFailed({
        command,
        code: "REPOSITORY_AMBIGUOUS",
        message: `Multiple configured Repositories match ${resolved.selector}: ${resolved.matches
          .map((repository) => formatRepositoryFullIdentity(repository))
          .join(", ")}`,
      })
    default: {
      const _exhaustive: never = resolved
      return _exhaustive
    }
  }
}

const toFiniteCommandFailed = (
  command: FiniteCommandName,
  error: unknown,
): FiniteCommandFailed => {
  if (error instanceof FiniteCommandFailed) {
    return error
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string"
  ) {
    const tagged = error as {
      readonly _tag: string
      readonly code?: string
      readonly message?: string
    }
    if (
      tagged._tag === "GraphqlRequestFailed" &&
      typeof tagged.code === "string" &&
      typeof tagged.message === "string"
    ) {
      return new FiniteCommandFailed({
        command,
        code: tagged.code,
        message: tagged.message,
      })
    }
    const message =
      error instanceof Error
        ? error.message
        : typeof tagged.message === "string"
          ? tagged.message
          : String(error)
    return new FiniteCommandFailed({
      command,
      code:
        command === "add" ? localGitErrorCode(tagged._tag) : "INTERNAL_ERROR",
      message,
    })
  }
  return new FiniteCommandFailed({
    command,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  })
}

const addRepositoryWorkflow = Effect.fn("Cli.addRepository")(function* (
  path: string,
  corrections: {
    readonly forgeHost?: string
    readonly projectPath?: string
  },
) {
  const localGit = yield* LocalGit
  const graphqlApi = yield* GraphqlApi
  const inspected = yield* localGit
    .inspect(path)
    .pipe(Effect.mapError((error) => toFiniteCommandFailed("add", error)))
  const repository = {
    ...inspected,
    ...(corrections.forgeHost === undefined
      ? {}
      : { forgeHost: corrections.forgeHost }),
    ...(corrections.projectPath === undefined
      ? {}
      : { projectPath: corrections.projectPath }),
  }
  const added = yield* graphqlApi
    .addRepository(repository)
    .pipe(Effect.mapError((error) => toFiniteCommandFailed("add", error)))

  // Exactly one compact JSON success document on stdout; no progress chatter.
  yield* Console.log(encodeCompactJson(buildAddSuccessDocument(added)))
})

const candidatesWorkflow = Effect.fn("Cli.candidates")(function* (
  repositoryArgument: string,
) {
  const graphqlApi = yield* GraphqlApi
  const repositories = yield* graphqlApi.listRepositories.pipe(
    Effect.mapError((error) => toFiniteCommandFailed("candidates", error)),
  )

  const resolved = resolveRepositoryIdentity(repositoryArgument, repositories)
  if (resolved._tag !== "matched") {
    return yield* repositoryIdentityCommandFailed("candidates", resolved)
  }

  const result = yield* graphqlApi
    .intakeCandidates(resolved.repository.id)
    .pipe(
      Effect.mapError((error) => toFiniteCommandFailed("candidates", error)),
    )

  yield* Console.log(
    encodeCompactJson(
      buildCandidatesSuccessDocument({
        repository: {
          id: result.repository.id,
          forge: result.repository.forge,
          forgeHost: result.repository.forgeHost,
          projectPath: result.repository.projectPath,
        },
        issuesReconciledAt: result.repository.issuesReconciledAt,
        candidates: result.candidates,
      }),
    ),
  )
})

const intakeWorkflow = Effect.fn("Cli.intake")(function* (
  repositoryArgument: string,
) {
  const graphqlApi = yield* GraphqlApi
  const repositories = yield* graphqlApi.listRepositories.pipe(
    Effect.mapError((error) => toFiniteCommandFailed("intake", error)),
  )

  const resolved = resolveRepositoryIdentity(repositoryArgument, repositories)
  if (resolved._tag !== "matched") {
    return yield* repositoryIdentityCommandFailed("intake", resolved)
  }

  const result = yield* graphqlApi
    .startRepositoryIntake(resolved.repository.id)
    .pipe(Effect.mapError((error) => toFiniteCommandFailed("intake", error)))

  // Complete result document on stdout even when some candidates failed.
  yield* Console.log(
    encodeCompactJson(
      buildIntakeSuccessDocument({
        repository: {
          id: result.repository.id,
          forge: result.repository.forge,
          forgeHost: result.repository.forgeHost,
          projectPath: result.repository.projectPath,
        },
        issuesReconciledAt: result.repository.issuesReconciledAt,
        results: result.results,
      }),
    ),
  )

  // Partial Intake exits 1 while keeping the result document on stdout.
  // Complete and empty Intake exit 0.
  yield* Effect.sync(() => {
    process.exitCode = intakeHasFailedResults(result.results) ? 1 : 0
  })
})

const statusWorkflow = Effect.fn("Cli.status")(function* (
  repositoryArgument: string | undefined,
) {
  const graphqlApi = yield* GraphqlApi

  let repositoryId: string | null = null
  let scopedRepository: ReturnType<
    typeof toCanonicalRepositoryIdentity
  > | null = null

  if (repositoryArgument !== undefined) {
    const repositories = yield* graphqlApi.listRepositories.pipe(
      Effect.mapError((error) => toFiniteCommandFailed("status", error)),
    )
    const resolved = resolveRepositoryIdentity(repositoryArgument, repositories)
    if (resolved._tag !== "matched") {
      return yield* repositoryIdentityCommandFailed("status", resolved)
    }
    repositoryId = resolved.repository.id
    scopedRepository = toCanonicalRepositoryIdentity(resolved.repository)
  }

  const status = yield* graphqlApi
    .kanbanStatus(repositoryId)
    .pipe(Effect.mapError((error) => toFiniteCommandFailed("status", error)))

  yield* Console.log(
    encodeCompactJson(
      buildStatusSuccessDocument({
        // Prefer the identity resolved from the operator selector when scoped;
        // otherwise use the GraphQL projection's repository (null for all).
        repository: scopedRepository ?? status.repository,
        lanes: status.lanes,
      }),
    ),
  )
})

const resolveJumpWorkingDirectory = (
  worktreePath: string | null,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (worktreePath === null) {
      return process.cwd()
    }
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs
      .stat(worktreePath)
      .pipe(Effect.orElseSucceed(() => null))
    if (info === null || info.type !== "Directory") {
      return process.cwd()
    }
    return worktreePath
  })

const jumpWorkflow = Effect.fn("Cli.jump")(function* (sessionId: string) {
  const tmux = yield* Tmux
  const directTerminal = yield* DirectTerminal
  const executablePath = yield* ExecutablePath
  const graphqlApi = yield* GraphqlApi

  const tmuxModeSelected = yield* tmux.tmuxModeSelected
  if (!tmuxModeSelected) {
    yield* directTerminal.requireInteractiveTerminal
  }

  const found = yield* graphqlApi
    .workItemBySessionId(sessionId)
    .pipe(
      Effect.mapError((error) => new JumpFailed({ message: error.message })),
    )

  const workingDirectory = yield* resolveJumpWorkingDirectory(
    found.worktreePath,
  )
  const resume = interactiveResumeCommand({
    backendId: found.agentBackend.id,
    sessionId: found.sessionId,
    workingDirectory,
  })
  if (resume === null) {
    return yield* new JumpFailed({
      message: `Unsupported Agent Backend: ${found.agentBackend.id}`,
    })
  }

  const agentExecutable = yield* executablePath.resolve(resume.executableName)
  if (tmuxModeSelected) {
    yield* tmux.createJumpWindow({
      sessionId: found.sessionId,
      workingDirectory,
      agentExecutable,
      agentArguments: resume.arguments,
      backendId: found.agentBackend.id,
    })
    return
  }

  const exitStatus = yield* directTerminal.run({
    agentExecutable,
    agentArguments: resume.arguments,
    workingDirectory,
  })
  yield* Effect.sync(() => {
    process.exitCode = exitStatus
  })
})

const startCommand = Command.make(
  "start",
  { noOpen: noOpenFlag, host: hostFlag },
  ({ noOpen, host }) =>
    startHarnessWorkflow(noOpen, Option.getOrUndefined(host)),
).pipe(
  Command.withDescription(
    "Start the full Harness (UI + backend); opens the browser unless --no-open / NO_BROWSER",
  ),
)

const addCommand = Command.make(
  "add",
  {
    path: pathArg,
    forgeHost: forgeHostFlag,
    projectPath: projectPathFlag,
  },
  ({ path, forgeHost, projectPath }) =>
    addRepositoryWorkflow(path, {
      forgeHost: Option.getOrUndefined(forgeHost),
      projectPath: Option.getOrUndefined(projectPath),
    }),
).pipe(
  Command.withDescription(
    "Inspect and add a local repository; inferred GitLab identity can be corrected with flags",
  ),
)

const candidatesCommand = Command.make(
  "candidates",
  { repository: repositoryIdentityArg },
  ({ repository }) => candidatesWorkflow(repository),
).pipe(
  Command.withDescription(
    "List current Intake Candidates for one Repository as versioned JSON",
  ),
)

const intakeCommand = Command.make(
  "intake",
  { repository: repositoryIdentityArg },
  ({ repository }) => intakeWorkflow(repository),
).pipe(
  Command.withDescription(
    "Start every current Intake Candidate for one Repository as versioned JSON",
  ),
)

const statusCommand = Command.make(
  "status",
  { repository: optionalRepositoryIdentityArg },
  ({ repository }) => statusWorkflow(Option.getOrUndefined(repository)),
).pipe(
  Command.withDescription(
    "Print the current six-lane Kanban status as versioned JSON (optional repository selector)",
  ),
)

const jumpCommand = Command.make(
  "jump",
  { sessionId: sessionIdArg },
  ({ sessionId }) => jumpWorkflow(sessionId),
).pipe(
  Command.withDescription(
    "Continue a Work Item Session (Interactive Session Continuation)",
  ),
)

export const cli = Command.make(
  "ready-for-agent",
  { noOpen: noOpenFlag, host: hostFlag },
  ({ noOpen, host }) =>
    startHarnessWorkflow(noOpen, Option.getOrUndefined(host)),
).pipe(
  Command.withDescription(
    "Ready for Agent operator binary (start Harness, add repositories, intake, Kanban status, jump)",
  ),
  Command.withSubcommands([
    startCommand,
    addCommand,
    candidatesCommand,
    intakeCommand,
    statusCommand,
    jumpCommand,
  ]),
)
