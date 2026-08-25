import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentBackend,
  AgentBackendExitError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  GitHubRequestError,
  type GitHubService,
  type UploadUserAttachmentInput,
} from "@ready-for-agent/github-service"
import type { LifecycleStepContext } from "../src/index.js"
import {
  CommitInvalidWorktreeContextError,
  CommitNoChangeConfirmationError,
  CommitOpenCodeError,
  CommitPostconditionError,
  type CommitResult,
  CommitSessionContextMissingError,
  CommitStartingCommitMissingError,
  CommitWorktreeContextMissingError,
  buildHarnessPublicationFallbackCopy,
  buildNoChangeConfirmationPrompt,
  commit,
  formatPublicationCommitMessage,
  makeWorkItemId,
  normalizePublicationCopy,
  parsePublicationCopyResult,
  publicationCopyFromCommitMessage,
  replaceMarkdownImageDestinations,
  resolveAttachmentImageCandidate,
  stubGitHubServiceLayer,
  workItemAttachmentDirectory,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const sampleCopy = {
  publicationTitle: "feat: add widgets endpoint",
  publicationBody:
    "Adds the widgets HTTP endpoint used by the dashboard.\n\nVerified with unit tests.\n\nCloses #91",
}

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  issueNumber: 91,
  issueTitle: "Add widgets endpoint",
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,
  publicationTitle: null,
  publicationBody: null,
  sessionId: "ses_implement_session",
  ...overrides,
})

const stubOpencode = (impl: {
  readonly startTurn?: (input: {
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  readonly continueTurn?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
}) =>
  Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: (input) =>
        impl.startTurn?.(input) ??
        Effect.succeed({
          sessionId: "ses_start_should_not_run",
          assistantText: "",
        }),
      continueTurn: (input) =>
        impl.continueTurn?.(input) ??
        Effect.succeed({ sessionId: "ses_commit_default", assistantText: "" }),
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, AgentBackend | GitHubService>,
  opencodeLayer: Layer.Layer<AgentBackend, never, never> = stubOpencode({}),
  githubLayer: Layer.Layer<
    GitHubService,
    never,
    never
  > = stubGitHubServiceLayer(),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(opencodeLayer),
      Effect.provide(githubLayer),
      Effect.provide(DbServiceLive),
      Effect.provide(DatabaseTest),
      Effect.provide(PlatformLayer),
    ),
  )

const seedRepository = (
  localPath: string,
  identity: {
    readonly forge: "github" | "gitlab"
    readonly forgeHost: string
    readonly projectPath: string
  } = {
    forge: "github",
    forgeHost: "github.com",
    projectPath: "acme/widgets",
  },
) =>
  Effect.gen(function* () {
    const db = yield* DbService
    return yield* db.addRepository({
      ...identity,
      localPath,
      isBare: false,
    })
  })

const seedWorkItem = (input: {
  readonly workItemId: string
  readonly repositoryId: string
  readonly issueNumber: number
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = Date.now()
    yield* sql.unsafe(
      `INSERT INTO work_item (
         id, repository_id, issue_number, state, state_ready_at, worktree_path,
         session_id, failure_code, failure_message, created_at, updated_at
       ) VALUES (?, ?, ?,
         'commit', ?, NULL, NULL, NULL, NULL, ?, ?)`,
      [input.workItemId, input.repositoryId, input.issueNumber, now, now, now],
    )
  })

const readPersistedPublicationCopy = (workItemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = (yield* sql.unsafe(
      `SELECT publication_title, publication_body FROM work_item WHERE id = ? LIMIT 1`,
      [workItemId],
    )) as readonly {
      readonly publication_title: string | null
      readonly publication_body: string | null
    }[]
    return rows[0] ?? null
  })

const writeAttachment = async (
  workItemId: string,
  name: string,
  contents = "png-bytes",
): Promise<string> => {
  const filePath = join(workItemAttachmentDirectory({ workItemId }), name)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
  return filePath
}

const git = async (cwd: string, args: ReadonlyArray<string>) => {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`,
    )
  }
  return stdout.trim()
}

const initWorktree = async (root: string) => {
  await git(root, ["init", "-b", "main"])
  await git(root, ["config", "user.email", "test@example.com"])
  await git(root, ["config", "user.name", "Test"])
  // Local-only: global commit.gpgsign would hang harness-owned git commit on
  // pinentry during tests (production worktrees inherit the operator's config).
  await git(root, ["config", "commit.gpgsign", "false"])
  await writeFile(join(root, "README.md"), "# widgets\n")
  await git(root, ["add", "README.md"])
  await git(root, ["commit", "--no-verify", "-m", "initial"])
  return git(root, ["rev-parse", "HEAD"])
}

const withTempRepo = async (
  assert: (root: string, startingOid: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-commit-"))
  try {
    const startingOid = await initWorktree(root)
    await assert(root, startingOid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const committedOf = (result: CommitResult) => {
  expect(result._tag).toBe("committed")
  if (result._tag !== "committed") {
    throw new Error("expected committed")
  }
  return result
}

const publicationResultLine = (title: string, body: string) =>
  `READY_FOR_AGENT_RESULT: PUBLICATION_COPY ${JSON.stringify({ title, body })}`

describe("publication copy parsing", () => {
  it("parses JSON on the result line and normalizes Closes", () => {
    const parsed = parsePublicationCopyResult(
      [
        "Here is the copy.",
        publicationResultLine(
          "feat: widgets",
          "Why we needed this.\n\nCloses #91",
        ),
      ].join("\n"),
    )
    expect(parsed).toEqual({
      title: "feat: widgets",
      body: "Why we needed this.\n\nCloses #91",
    })
    expect(normalizePublicationCopy(parsed!, 91)).toEqual({
      title: "feat: widgets",
      body: "Why we needed this.\n\nCloses #91",
    })
  })

  it("rejects blank, generic, or missing results", () => {
    expect(parsePublicationCopyResult("no marker")).toBeNull()
    expect(
      normalizePublicationCopy(
        {
          title: "  ",
          body: "something substantive enough",
        },
        1,
      ),
    ).toBeNull()
    expect(
      normalizePublicationCopy(
        {
          title: "feat: x",
          body: "Automated draft pull request for GitHub issue #1.",
        },
        1,
      ),
    ).toBeNull()
  })

  it("accepts the last valid PUBLICATION_COPY marker after trailing prose or malformed candidates", () => {
    const parsed = parsePublicationCopyResult(
      [
        publicationResultLine("bad", ""),
        publicationResultLine(
          "feat: widgets",
          "Adds the widgets endpoint used by the dashboard.",
        ),
        "trailing prose after the marker",
      ].join("\n"),
    )
    expect(parsed).toEqual({
      title: "feat: widgets",
      body: "Adds the widgets endpoint used by the dashboard.",
    })
  })

  it("accepts a PUBLICATION_COPY marker wrapped in inline code", () => {
    const parsed = parsePublicationCopyResult(
      `\`${publicationResultLine("feat: widgets", "Adds the widgets endpoint used by the dashboard.")}\``,
    )
    expect(parsed).toEqual({
      title: "feat: widgets",
      body: "Adds the widgets endpoint used by the dashboard.",
    })
  })

  it("does not treat PASS or surrounding prose as publication copy", () => {
    expect(
      parsePublicationCopyResult("`READY_FOR_AGENT_RESULT: PASS`"),
    ).toBeNull()
    expect(
      parsePublicationCopyResult(
        'Here is some JSON {"title":"x","body":"y"} without a marker',
      ),
    ).toBeNull()
  })

  it("builds deterministic harness fallback copy from the Issue identity", () => {
    const copy = buildHarnessPublicationFallbackCopy({
      issueNumber: 12,
      issueTitle: null,
      workItemId: "wi-01TESTFALLBACKCOPY00000000",
    })
    expect(copy.title).toBe("Implement issue #12")
    expect(copy.body).toContain("wi-01TESTFALLBACKCOPY00000000")
    expect(copy.body.endsWith("Closes #12")).toBe(true)
    expect(copy.body.match(/Closes #12/g)?.length).toBe(1)
  })

  it("formats commit message from title and body", () => {
    expect(
      formatPublicationCommitMessage({
        title: "feat: x",
        body: "Why\n\nCloses #1",
      }),
    ).toBe("feat: x\n\nWhy\n\nCloses #1")
  })

  it("seeds from a legacy commit body that is only Closes without doubling", () => {
    const seeded = publicationCopyFromCommitMessage(
      "prior commit\n\nCloses #91",
      91,
    )
    expect(seeded).not.toBeNull()
    expect(seeded!.title).toBe("prior commit")
    // Body matches the commit body (single Closes); no invented prose.
    expect(seeded!.body).toBe("Closes #91")
    expect(seeded!.body.match(/Closes #91/g)?.length).toBe(1)
    expect(formatPublicationCommitMessage(seeded!)).toBe(
      "prior commit\n\nCloses #91",
    )
  })

  it("strips trailing-period and list-form closing references when normalizing", () => {
    const withPeriod = normalizePublicationCopy(
      {
        title: "feat: widgets",
        body: "Adds widgets.\n\nCloses #7.",
      },
      7,
    )
    expect(withPeriod).not.toBeNull()
    expect(withPeriod!.body.match(/Closes #7/g)?.length).toBe(1)
    expect(withPeriod!.body).not.toContain("Closes #7.")

    const listForm = normalizePublicationCopy(
      {
        title: "feat: widgets",
        body: "Adds widgets.\n\n- Closes #7",
      },
      7,
    )
    expect(listForm).not.toBeNull()
    expect(listForm!.body.match(/Closes #7/g)?.length).toBe(1)
  })
})

describe("publication copy image rewrite", () => {
  const attachmentDirectory =
    "/tmp/ready-for-agent/pr-attachments/wi-01HABCDEFGHJKMNPQRSTVWXYZ"

  it("refuses destinations outside the attachment directory", () => {
    expect(
      resolveAttachmentImageCandidate({
        destination: "/etc/passwd",
        attachmentDirectory,
      }),
    ).toBeNull()
    expect(
      resolveAttachmentImageCandidate({
        destination: "../escape.png",
        attachmentDirectory,
      }),
    ).toBeNull()
    expect(
      resolveAttachmentImageCandidate({
        destination: `${attachmentDirectory}/../outside.png`,
        attachmentDirectory,
      }),
    ).toBeNull()
  })

  it("accepts png jpeg gif webp inside the directory and rejects other types", () => {
    expect(
      resolveAttachmentImageCandidate({
        destination: `${attachmentDirectory}/shot.png`,
        attachmentDirectory,
      }),
    ).toEqual({
      filePath: `${attachmentDirectory}/shot.png`,
      name: "shot.png",
      contentType: "image/png",
    })
    expect(
      resolveAttachmentImageCandidate({
        destination: "shot.jpg",
        attachmentDirectory,
      }),
    ).toEqual({
      filePath: `${attachmentDirectory}/shot.jpg`,
      name: "shot.jpg",
      contentType: "image/jpeg",
    })
    expect(
      resolveAttachmentImageCandidate({
        destination: "shot.jpeg",
        attachmentDirectory,
      })?.contentType,
    ).toBe("image/jpeg")
    expect(
      resolveAttachmentImageCandidate({
        destination: "shot.gif",
        attachmentDirectory,
      })?.contentType,
    ).toBe("image/gif")
    expect(
      resolveAttachmentImageCandidate({
        destination: "shot.webp",
        attachmentDirectory,
      })?.contentType,
    ).toBe("image/webp")
    expect(
      resolveAttachmentImageCandidate({
        destination: "notes.txt",
        attachmentDirectory,
      }),
    ).toBeNull()
    expect(
      resolveAttachmentImageCandidate({
        destination: "https://example.com/shot.png",
        attachmentDirectory,
      }),
    ).toBeNull()
  })

  it("leaves unknown and remote image links unchanged", () => {
    const body = [
      "See ![remote](https://example.com/a.png)",
      "and ![cdn](https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee).",
    ].join("\n")
    expect(replaceMarkdownImageDestinations(body, new Map())).toBe(body)
    expect(
      replaceMarkdownImageDestinations(
        body,
        new Map([
          [
            "/tmp/x.png",
            "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555",
          ],
        ]),
      ),
    ).toBe(body)
  })

  it("replaces the destination when alt or title repeats the local path", () => {
    const localPath =
      "/tmp/ready-for-agent/pr-attachments/wi-01HABCDEFGHJKMNPQRSTVWXYZ/shot.png"
    const url =
      "https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    const replacements = new Map([[localPath, url]])

    expect(
      replaceMarkdownImageDestinations(
        `![${localPath}](${localPath})`,
        replacements,
      ),
    ).toBe(`![${localPath}](${url})`)
    expect(
      replaceMarkdownImageDestinations(
        `![before](${localPath} "${localPath}")`,
        replacements,
      ),
    ).toBe(`![before](${url} "${localPath}")`)
  })
})

describe("commit", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(commit(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommitWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-commit-missing-worktree")
    const error = await run(commit(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommitInvalidWorktreeContextError)
  })

  it("rejects missing starting commit OID", () =>
    withTempRepo(async (root) => {
      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: null,
          }),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CommitStartingCommitMissingError)
    }))

  it("native commit uses persisted publication copy without a generation turn", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      let continued = 0
      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
              sessionId: "ses_from_implement",
              issueNumber: 2039,
              issueTitle: "Fix the widgets path",
              publicationTitle: "fix: widgets path",
              publicationBody:
                "Corrects the widgets route used by the API.\n\nCloses #2039",
            }),
          ),
          stubOpencode({
            continueTurn: () => {
              continued += 1
              return Effect.succeed({
                sessionId: "ses_from_implement",
                assistantText: "",
              })
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("fix: widgets path")
      expect(result.publicationBody).toContain("Corrects the widgets route")
      expect(result.publicationBody).toContain("Closes #2039")
      expect(continued).toBe(0)

      const count = await git(root, [
        "rev-list",
        "--count",
        `${startingOid}..HEAD`,
      ])
      expect(count).toBe("1")
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toContain("fix: widgets path")
      expect(message).toContain("Corrects the widgets route")
      expect(message).toContain("Closes #2039")
      expect(message).not.toContain("Automated draft pull request")
      expect(await git(root, ["status", "--porcelain"])).toBe("")
    }))

  it("does not expose Harness-owned environment to commit hooks", () =>
    withTempRepo(async (root, startingOid) => {
      const databaseRoot = await mkdtemp(join(tmpdir(), "rfa-commit-db-"))
      const databasePath = join(databaseRoot, "harness.db")
      const observedEnvironmentPath = join(databaseRoot, "commit-environment")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      const hookPath = join(hooks, "pre-commit")
      await writeFile(
        hookPath,
        [
          "#!/usr/bin/env bash",
          "set -eo pipefail",
          'printf "%s" "$RFA_COMMIT_TEST_VALUE" > "$RFA_COMMIT_OBSERVED_PATH"',
          'if [[ -n "$SQLITE_DATABASE_PATH" ]]; then',
          '  rm -f "$SQLITE_DATABASE_PATH" "$SQLITE_DATABASE_PATH-shm" "$SQLITE_DATABASE_PATH-wal"',
          "fi",
          "",
        ].join("\n"),
      )
      await chmod(hookPath, 0o755)
      await writeFile(databasePath, "live harness data\n")
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      const originalDatabasePath = process.env["SQLITE_DATABASE_PATH"]
      const originalTestValue = process.env["RFA_COMMIT_TEST_VALUE"]
      const originalObservedPath = process.env["RFA_COMMIT_OBSERVED_PATH"]
      process.env["SQLITE_DATABASE_PATH"] = databasePath
      process.env["RFA_COMMIT_TEST_VALUE"] = "preserved"
      process.env["RFA_COMMIT_OBSERVED_PATH"] = observedEnvironmentPath
      try {
        const result = committedOf(
          await run(
            commit(
              baseContext(root, {
                startingCommitOid: startingOid,
                publicationTitle: "fix: protect harness environment",
                publicationBody:
                  "Keeps Harness state outside repository hooks.\n\nCloses #91",
              }),
            ),
          ),
        )

        expect(result.completion).toBe("native")
        expect(await readFile(databasePath, "utf8")).toBe("live harness data\n")
        expect(await readFile(observedEnvironmentPath, "utf8")).toBe(
          "preserved",
        )
      } finally {
        if (originalDatabasePath === undefined) {
          delete process.env["SQLITE_DATABASE_PATH"]
        } else {
          process.env["SQLITE_DATABASE_PATH"] = originalDatabasePath
        }
        if (originalTestValue === undefined) {
          delete process.env["RFA_COMMIT_TEST_VALUE"]
        } else {
          process.env["RFA_COMMIT_TEST_VALUE"] = originalTestValue
        }
        if (originalObservedPath === undefined) {
          delete process.env["RFA_COMMIT_OBSERVED_PATH"]
        } else {
          process.env["RFA_COMMIT_OBSERVED_PATH"] = originalObservedPath
        }
        await rm(databaseRoot, { recursive: true, force: true })
      }
    }))

  it("generates publication copy once then commits natively", () =>
    withTempRepo(async (root, startingOid) => {
      const workItemId = makeWorkItemId()
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const prompts: string[] = []

      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              workItemId,
              startingCommitOid: startingOid,
              issueNumber: 42,
              sessionId: "ses_from_implement",
            }),
          ),
          stubOpencode({
            continueTurn: (input) => {
              prompts.push(input.prompt)
              return Effect.succeed({
                sessionId: input.sessionId,
                assistantText: publicationResultLine(
                  "feat: implement widgets",
                  "Implements widgets as requested.\n\nVerified via local checks.",
                ),
              })
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("feat: implement widgets")
      expect(result.publicationBody).toContain("Implements widgets")
      expect(result.publicationBody).toContain("Closes #42")
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("Write copy only")
      expect(prompts[0]).toContain("Do not edit files")
      expect(prompts[0]).toContain(workItemAttachmentDirectory({ workItemId }))
      expect(prompts[0]).toMatch(/[Dd]o not .*open or edit pull requests/)
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message.startsWith("feat: implement widgets")).toBe(true)
      expect(message).toContain("Closes #42")
    }))

  it("uploads in-directory publication images once and persists the rewritten body", () =>
    withTempRepo(async (root, startingOid) => {
      const workItemId = makeWorkItemId()
      const imagePath = await writeAttachment(workItemId, "before.png")
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const attachmentUrl =
        "https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      const uploads: UploadUserAttachmentInput[] = []

      const result = await run(
        Effect.gen(function* () {
          const repository = yield* seedRepository(root)
          yield* seedWorkItem({
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
          })
          const outcome = committedOf(
            yield* commit(
              baseContext(root, {
                workItemId,
                repositoryId: repository.id,
                startingCommitOid: startingOid,
                issueNumber: 42,
                sessionId: "ses_from_implement",
              }),
            ),
          )
          const persisted = yield* readPersistedPublicationCopy(workItemId)
          return { outcome, persisted }
        }),
        stubOpencode({
          continueTurn: (input) =>
            Effect.succeed({
              sessionId: input.sessionId,
              assistantText: publicationResultLine(
                "feat: implement widgets",
                `Implements widgets as requested.\n\n![before](${imagePath})\n\nVerified via local checks.`,
              ),
            }),
        }),
        stubGitHubServiceLayer({
          uploadUserAttachment: (_repository, input) => {
            uploads.push(input)
            return Effect.succeed(attachmentUrl)
          },
        }),
      )

      expect(result.outcome.completion).toBe("native")
      expect(result.outcome.publicationTitle).toBe("feat: implement widgets")
      expect(result.outcome.publicationBody).toContain(attachmentUrl)
      expect(result.outcome.publicationBody).not.toContain(imagePath)
      expect(result.outcome.publicationBody.endsWith("Closes #42")).toBe(true)
      expect(result.persisted?.publication_title).toBe(
        result.outcome.publicationTitle,
      )
      expect(result.persisted?.publication_body).toBe(
        result.outcome.publicationBody,
      )
      expect(uploads).toEqual([
        {
          name: "before.png",
          contentType: "image/png",
          filePath: imagePath,
        },
      ])
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toBe(
        formatPublicationCommitMessage({
          title: result.outcome.publicationTitle,
          body: result.outcome.publicationBody,
        }),
      )
      expect(message).toContain(attachmentUrl)
      expect(message).not.toContain(imagePath)
      expect(message).toContain("Closes #42")
    }))

  it("reuses already-persisted copy without a second upload or copy turn", () =>
    withTempRepo(async (root, startingOid) => {
      const workItemId = makeWorkItemId()
      const imagePath = await writeAttachment(workItemId, "before.png")
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const persistedBody = `Already rewritten with ![before](https://github.com/user-attachments/assets/bbbbbbbb-cccc-dddd-eeee-ffffffffffff) and leftover ![local](${imagePath}).\n\nCloses #91`
      let continued = 0
      let uploads = 0

      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              workItemId,
              startingCommitOid: startingOid,
              publicationTitle: "feat: already persisted",
              publicationBody: persistedBody,
            }),
          ),
          stubOpencode({
            continueTurn: () => {
              continued += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText: "",
              })
            },
          }),
          stubGitHubServiceLayer({
            uploadUserAttachment: () => {
              uploads += 1
              return Effect.succeed(
                "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555",
              )
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(continued).toBe(0)
      expect(uploads).toBe(0)
      expect(result.publicationBody).toBe(persistedBody)
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toContain(persistedBody)
    }))

  it("leaves a missing or failed upload image alone and still commits", () =>
    withTempRepo(async (root, startingOid) => {
      const workItemId = makeWorkItemId()
      const missingPath = join(
        workItemAttachmentDirectory({ workItemId }),
        "missing.png",
      )
      const failedPath = await writeAttachment(workItemId, "failed.png")
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      const result = committedOf(
        await run(
          Effect.gen(function* () {
            const repository = yield* seedRepository(root)
            return yield* commit(
              baseContext(root, {
                workItemId,
                repositoryId: repository.id,
                startingCommitOid: startingOid,
                issueNumber: 42,
                sessionId: "ses_from_implement",
              }),
            )
          }),
          stubOpencode({
            continueTurn: (input) =>
              Effect.succeed({
                sessionId: input.sessionId,
                assistantText: publicationResultLine(
                  "feat: implement widgets",
                  `Shows ![missing](${missingPath}) and ![failed](${failedPath}).`,
                ),
              }),
          }),
          stubGitHubServiceLayer({
            uploadUserAttachment: () =>
              Effect.fail(
                new GitHubRequestError({
                  message: "Failed to upload user attachment",
                  statusCode: 404,
                  retryable: false,
                }),
              ),
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationBody).toContain(missingPath)
      expect(result.publicationBody).toContain(failedPath)
      expect(result.publicationBody).toContain("Closes #42")
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toContain(missingPath)
      expect(message).toContain(failedPath)
    }))

  it("does not upload image paths outside the attachment directory", () =>
    withTempRepo(async (root, startingOid) => {
      const workItemId = makeWorkItemId()
      const outsidePath = join(root, "secret.png")
      await writeFile(outsidePath, "secret")
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      let uploads = 0

      const result = committedOf(
        await run(
          Effect.gen(function* () {
            const repository = yield* seedRepository(root)
            return yield* commit(
              baseContext(root, {
                workItemId,
                repositoryId: repository.id,
                startingCommitOid: startingOid,
                issueNumber: 42,
                sessionId: "ses_from_implement",
              }),
            )
          }),
          stubOpencode({
            continueTurn: (input) =>
              Effect.succeed({
                sessionId: input.sessionId,
                assistantText: publicationResultLine(
                  "feat: implement widgets",
                  `Must not read ![outside](${outsidePath}).`,
                ),
              }),
          }),
          stubGitHubServiceLayer({
            uploadUserAttachment: () => {
              uploads += 1
              return Effect.succeed(
                "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555",
              )
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(uploads).toBe(0)
      expect(result.publicationBody).toContain(outsidePath)
    }))

  it("does not upload unreferenced files in the attachment directory", () =>
    withTempRepo(async (root, startingOid) => {
      const workItemId = makeWorkItemId()
      const referenced = await writeAttachment(workItemId, "before.png")
      const unused = await writeAttachment(workItemId, "unused.png")
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const uploads: string[] = []

      const result = committedOf(
        await run(
          Effect.gen(function* () {
            const repository = yield* seedRepository(root)
            return yield* commit(
              baseContext(root, {
                workItemId,
                repositoryId: repository.id,
                startingCommitOid: startingOid,
                issueNumber: 42,
                sessionId: "ses_from_implement",
              }),
            )
          }),
          stubOpencode({
            continueTurn: (input) =>
              Effect.succeed({
                sessionId: input.sessionId,
                assistantText: publicationResultLine(
                  "feat: implement widgets",
                  `Only this shot: ![before](${referenced}).`,
                ),
              }),
          }),
          stubGitHubServiceLayer({
            uploadUserAttachment: (_repository, input) => {
              uploads.push(input.filePath)
              return Effect.succeed(
                "https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              )
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(uploads).toEqual([referenced])
      expect(result.publicationBody).not.toContain(unused)
      expect(result.publicationBody).not.toContain("unused.png")
    }))

  it("does not upload publication images for a GitLab repository", () =>
    withTempRepo(async (root, startingOid) => {
      const workItemId = makeWorkItemId()
      const imagePath = await writeAttachment(workItemId, "before.png")
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      let uploads = 0

      const result = committedOf(
        await run(
          Effect.gen(function* () {
            const repository = yield* seedRepository(root, {
              forge: "gitlab",
              forgeHost: "gitlab.example.com",
              projectPath: "acme/widgets",
            })
            return yield* commit(
              baseContext(root, {
                workItemId,
                repositoryId: repository.id,
                startingCommitOid: startingOid,
                issueNumber: 42,
                sessionId: "ses_from_implement",
              }),
            )
          }),
          stubOpencode({
            continueTurn: (input) =>
              Effect.succeed({
                sessionId: input.sessionId,
                assistantText: publicationResultLine(
                  "feat: implement widgets",
                  `GitLab shot ![before](${imagePath}).`,
                ),
              }),
          }),
          stubGitHubServiceLayer({
            uploadUserAttachment: () => {
              uploads += 1
              return Effect.succeed(
                "https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              )
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(uploads).toBe(0)
      expect(result.publicationBody).toContain(imagePath)
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toContain(imagePath)
    }))

  it("retries generation once on malformed copy then commits harness fallback copy", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const workItemId = makeWorkItemId()
      let calls = 0
      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              workItemId,
              startingCommitOid: startingOid,
              issueNumber: 9,
              issueTitle: "Ship the widgets",
            }),
          ),
          stubOpencode({
            continueTurn: () => {
              calls += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  calls === 1
                    ? "not a valid result"
                    : "`READY_FOR_AGENT_RESULT: PASS`",
              })
            },
          }),
        ),
      )
      const expected = buildHarnessPublicationFallbackCopy({
        issueNumber: 9,
        issueTitle: "Ship the widgets",
        workItemId,
      })
      expect(calls).toBe(2)
      expect(result.completion).toBe("native")
      expect(result.publicationCopySource).toBe("harness_fallback")
      expect(result.publicationTitle).toBe("Ship the widgets")
      expect(result.publicationBody).toBe(expected.body)
      expect(result.publicationBody).toContain(`Work Item ${workItemId}`)
      expect(result.publicationBody).toContain("Closes #9")
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("1")
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message.startsWith("Ship the widgets")).toBe(true)
      expect(message).toContain("Harness publication-copy fallback")
    }))

  it("reuses persisted harness fallback copy without a generation turn", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const workItemId = makeWorkItemId()
      const fallback = buildHarnessPublicationFallbackCopy({
        issueNumber: 91,
        issueTitle: "Add widgets endpoint",
        workItemId,
      })
      let continued = 0
      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              workItemId,
              startingCommitOid: startingOid,
              publicationTitle: fallback.title,
              publicationBody: fallback.body,
            }),
          ),
          stubOpencode({
            continueTurn: () => {
              continued += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText: "",
              })
            },
          }),
        ),
      )
      expect(continued).toBe(0)
      expect(result.publicationCopySource).toBe("harness_fallback")
      expect(result.publicationTitle).toBe(fallback.title)
      expect(result.publicationBody).toBe(fallback.body)
      const message = await git(root, ["log", "-1", "--pretty=%B"])
      expect(message).toContain("Harness publication-copy fallback")
    }))

  it("still sends harness fallback copy to agent repair when commit-msg policy rejects it", () =>
    withTempRepo(async (root, startingOid) => {
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      const hookPath = join(hooks, "commit-msg")
      await writeFile(
        hookPath,
        `#!/bin/sh
if ! grep -q '^feat:' "$1"; then
  echo "commitlint: subject must start with feat:" >&2
  exit 1
fi
`,
      )
      await chmod(hookPath, 0o755)
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const workItemId = makeWorkItemId()
      const fallback = buildHarnessPublicationFallbackCopy({
        issueNumber: 2039,
        issueTitle: "Add widgets without conventional prefix",
        workItemId,
      })
      let repairPrompt = ""
      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              workItemId,
              startingCommitOid: startingOid,
              sessionId: "ses_from_implement",
              issueNumber: 2039,
              publicationTitle: fallback.title,
              publicationBody: fallback.body,
            }),
          ),
          stubOpencode({
            continueTurn: (input) =>
              Effect.gen(function* () {
                repairPrompt = input.prompt
                yield* Effect.tryPromise({
                  try: async () => {
                    await git(root, ["add", "feature.ts"])
                    await git(root, [
                      "commit",
                      "--no-verify",
                      "-m",
                      "feat: add widgets\n\nPolicy-fixed body\n\nCloses #2039",
                    ])
                  },
                  catch: (cause) => cause as Error,
                })
                return { sessionId: input.sessionId, assistantText: "" }
              }).pipe(Effect.orDie),
          }),
        ),
      )
      expect(result.completion).toBe("agent_fallback")
      expect(repairPrompt).toContain("commitlint")
      expect(repairPrompt).toContain(fallback.title)
      expect(repairPrompt).toContain("Harness publication-copy fallback")
      expect(result.publicationTitle).toBe("feat: add widgets")
    }))

  it("native commit leaves untracked harness artifacts uncommitted", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await mkdir(join(root, ".ready-for-agent"), { recursive: true })
      await writeFile(join(root, ".ready-for-agent", "noise.log"), "harness\n")

      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
              issueNumber: 2039,
              ...sampleCopy,
              publicationBody:
                "Corrects the widgets route used by the API.\n\nCloses #2039",
              publicationTitle: "fix: widgets path",
            }),
          ),
        ),
      )

      expect(result.completion).toBe("native")
      const status = await git(root, ["status", "--porcelain"])
      expect(status).toContain(".ready-for-agent/")
      expect(status).not.toContain("feature.ts")
    }))

  it("excludes harness artifacts even when Pre-Commit already staged them", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await mkdir(join(root, ".ready-for-agent"), { recursive: true })
      await writeFile(join(root, ".ready-for-agent", "noise.log"), "harness\n")
      await git(root, ["add", "-A"])

      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
              issueNumber: 12,
              publicationTitle: "chore: keep diagnostics out",
              publicationBody:
                "Ensures harness artifacts stay uncommitted.\n\nCloses #12",
            }),
          ),
        ),
      )

      expect(result.completion).toBe("native")
      const tree = await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])
      expect(tree).toContain("feature.ts")
      expect(tree).not.toContain(".ready-for-agent")
      const status = await git(root, ["status", "--porcelain"])
      expect(status).toContain(".ready-for-agent/")
    }))

  it("reuses an existing postcondition and seeds copy from the commit when absent", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await git(root, ["add", "feature.ts"])
      await git(root, [
        "commit",
        "--no-verify",
        "-m",
        "prior commit\n\nCloses #91",
      ])
      const headBefore = await git(root, ["rev-parse", "HEAD"])

      let continued = 0
      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
            }),
          ),
          stubOpencode({
            continueTurn: () => {
              continued += 1
              return Effect.succeed({
                sessionId: "ses",
                assistantText: "",
              })
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("prior commit")
      expect(result.publicationBody).toContain("Closes #91")
      expect(result.publicationBody.match(/Closes #91/g)?.length).toBe(1)
      expect(continued).toBe(0)
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(headBefore)
    }))

  it("prefers HEAD over stale persisted copy when already committed", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await git(root, ["add", "feature.ts"])
      await git(root, [
        "commit",
        "--no-verify",
        "-m",
        "feat: actual head message\n\nPolicy-fixed body\n\nCloses #91",
      ])

      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
              publicationTitle: "stale title from mid-persist",
              publicationBody: "Stale body that must not win.\n\nCloses #91",
            }),
          ),
        ),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("feat: actual head message")
      expect(result.publicationBody).toContain("Policy-fixed body")
      expect(result.publicationBody).not.toContain("Stale body")
    }))

  it("falls back to one repair Agent Turn when the commit-msg hook rejects the message", () =>
    withTempRepo(async (root, startingOid) => {
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      const hookPath = join(hooks, "commit-msg")
      await writeFile(
        hookPath,
        `#!/bin/sh
if ! grep -q '^feat:' "$1"; then
  echo "commitlint: subject must start with feat:" >&2
  exit 1
fi
`,
      )
      await chmod(hookPath, 0o755)

      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      let continued: {
        sessionId: string
        prompt: string
        cwd: string
      } | null = null
      let agentCalls = 0

      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
              sessionId: "ses_from_implement",
              issueNumber: 2039,
              publicationTitle: "Add feature without conventional prefix",
              publicationBody: "Adds the feature file.\n\nCloses #2039",
              model: "opencode/commit-model",
              thinkingLevel: "max",
              maxDuration: Duration.minutes(10),
            }),
          ),
          stubOpencode({
            continueTurn: (input) =>
              Effect.gen(function* () {
                agentCalls += 1
                continued = input
                yield* Effect.tryPromise({
                  try: async () => {
                    await git(root, ["add", "feature.ts"])
                    await git(root, [
                      "commit",
                      "--no-verify",
                      "-m",
                      "feat: add feature\n\nPolicy-fixed body\n\nCloses #2039",
                    ])
                  },
                  catch: (cause) => cause as Error,
                })
                return {
                  sessionId: input.sessionId,
                  assistantText: "",
                }
              }).pipe(Effect.orDie),
          }),
        ),
      )

      expect(result.completion).toBe("agent_fallback")
      expect(agentCalls).toBe(1)
      expect(continued).not.toBeNull()
      expect(continued!.sessionId).toBe("ses_from_implement")
      expect(continued!.cwd).toBe(root)
      expect(continued!.prompt).toContain("commitlint")
      expect(continued!.prompt).toContain("Prefer this exact commit message")
      expect(continued!.prompt).toContain("Bounded native failure diagnostics")
      // Canonical copy updated from the agent-rewritten commit.
      expect(result.publicationTitle).toBe("feat: add feature")
      expect(result.publicationBody).toContain("Policy-fixed body")
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("1")
    }))

  it("does not invoke agent when postcondition is already met", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await git(root, ["add", "feature.ts"])
      await git(root, [
        "commit",
        "--no-verify",
        "-m",
        "already committed\n\nCloses #91",
      ])

      let continued = 0
      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
              publicationTitle: "already committed",
              publicationBody: "Seeded.\n\nCloses #91",
            }),
          ),
          stubOpencode({
            continueTurn: () => {
              continued += 1
              return Effect.succeed({
                sessionId: "ses",
                assistantText: "",
              })
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(continued).toBe(0)
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("1")
    }))

  it("fails when native and fallback both leave the postcondition unmet", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      const hookPath = join(hooks, "commit-msg")
      await writeFile(
        hookPath,
        `#!/bin/sh
echo always fail >&2
exit 1
`,
      )
      await chmod(hookPath, 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: "ses_from_implement",
            publicationTitle: "feat: always fail",
            publicationBody: "Will not commit.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: () =>
            Effect.succeed({
              sessionId: "ses_from_implement",
              assistantText: "",
            }),
        }),
      )

      expect(error).toBeInstanceOf(CommitPostconditionError)
      expect((error as CommitPostconditionError).worktreePath).toBe(root)
    }))

  it("requires Session context for copy generation and agent fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: null,
          }),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CommitSessionContextMissingError)
    }))

  it("maps OpenCode exit failure during fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      await writeFile(
        join(hooks, "commit-msg"),
        `#!/bin/sh
exit 1
`,
      )
      await chmod(join(hooks, "commit-msg"), 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: x",
            publicationBody: "Body text for failure path.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(
                AgentBackendExitError.new({
                  exitCode: 2,
                  cwd: root,
                  message: "OpenCode failed with exit code 2",
                }),
              ),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
      expect((error as CommitOpenCodeError).worktreePath).toBe(root)
      expect((error as CommitOpenCodeError).sessionId).toBe(
        "ses_implement_session",
      )
    }))

  it("maps OpenCode timeout failure during fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      await writeFile(
        join(hooks, "commit-msg"),
        `#!/bin/sh
exit 1
`,
      )
      await chmod(join(hooks, "commit-msg"), 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: x",
            publicationBody: "Body text for timeout path.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(
                new AgentBackendTimeoutError({ cwd: root, timeoutMs: 1_000 }),
              ),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
    }))

  it("maps missing Session ID from OpenCode during fallback", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      await writeFile(
        join(hooks, "commit-msg"),
        `#!/bin/sh
exit 1
`,
      )
      await chmod(join(hooks, "commit-msg"), 0o755)

      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: x",
            publicationBody: "Body text for session path.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        Layer.succeed(
          AgentBackend,
          AgentBackend.of({
            startTurn: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continueTurn: () =>
              Effect.fail(new AgentBackendSessionIdMissingError({ cwd: root })),
            inspect: () =>
              Effect.succeed({
                backend: { id: "opencode" as const, label: "OpenCode" },
                models: [],
              }),
          }),
        ),
      )
      expect(error).toBeInstanceOf(CommitOpenCodeError)
    }))

  it("confirms a late No-Change Outcome when nothing remains to publish", () =>
    withTempRepo(async (root, startingOid) => {
      const prompts: string[] = []
      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: "ses_from_implement",
          }),
        ),
        stubOpencode({
          continueTurn: (input) => {
            prompts.push(input.prompt)
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText:
                "Investigated without edits.\nREADY_FOR_AGENT_RESULT: NO_CHANGES",
            })
          },
        }),
      )

      expect(result).toEqual({
        _tag: "no_changes",
        completionSummary: "Investigated without edits.",
      })
      expect(prompts).toEqual([buildNoChangeConfirmationPrompt()])
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("0")
    }))

  it("treats harness-only dirt as nothing to publish and confirms No-Change", () =>
    withTempRepo(async (root, startingOid) => {
      await mkdir(join(root, ".ready-for-agent"), { recursive: true })
      await writeFile(join(root, ".ready-for-agent", "noise.log"), "harness\n")
      const prompts: string[] = []
      const result = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
          }),
        ),
        stubOpencode({
          continueTurn: (input) => {
            prompts.push(input.prompt)
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText:
                "Diagnostics only.\nREADY_FOR_AGENT_RESULT: NO_CHANGES",
            })
          },
        }),
      )

      expect(result).toEqual({
        _tag: "no_changes",
        completionSummary: "Diagnostics only.",
      })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(buildNoChangeConfirmationPrompt())
      const tree = await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])
      expect(tree).not.toContain(".ready-for-agent")
    }))

  it("fails retryably when nothing to publish and the Session reports CHANGES", () =>
    withTempRepo(async (root, startingOid) => {
      let continued = 0
      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: leftover copy",
            publicationBody: "Must not be used.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: (input) => {
            continued += 1
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "READY_FOR_AGENT_RESULT: CHANGES",
            })
          },
        }),
      )

      expect(error).toBeInstanceOf(CommitNoChangeConfirmationError)
      expect((error as CommitNoChangeConfirmationError).message).toContain(
        "did not confirm a No-Change Outcome",
      )
      expect(continued).toBe(1)
      expect(
        await git(root, ["rev-list", "--count", `${startingOid}..HEAD`]),
      ).toBe("0")
    }))

  it("fails retryably when nothing to publish and the confirmation result is malformed", () =>
    withTempRepo(async (root, startingOid) => {
      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: (input) =>
            Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "READY_FOR_AGENT_RESULT: NO_CHANGES",
            }),
        }),
      )

      expect(error).toBeInstanceOf(CommitNoChangeConfirmationError)
      expect((error as CommitNoChangeConfirmationError).message).toContain(
        "did not return a valid READY_FOR_AGENT_RESULT",
      )
    }))

  it("asks again on retry after a CHANGES confirmation", () =>
    withTempRepo(async (root, startingOid) => {
      let continued = 0
      const first = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: (input) => {
            continued += 1
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "READY_FOR_AGENT_RESULT: CHANGES",
            })
          },
        }),
      )
      expect(first).toBeInstanceOf(CommitNoChangeConfirmationError)

      const second = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
          }),
        ),
        stubOpencode({
          continueTurn: (input) => {
            continued += 1
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText:
                "Objective is complete.\nREADY_FOR_AGENT_RESULT: NO_CHANGES",
            })
          },
        }),
      )
      expect(second).toEqual({
        _tag: "no_changes",
        completionSummary: "Objective is complete.",
      })
      expect(continued).toBe(2)
    }))

  it("does not confirm No-Change when a commit already exists after the starting commit", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      await git(root, ["add", "feature.ts"])
      await git(root, [
        "commit",
        "--no-verify",
        "-m",
        "already committed\n\nCloses #91",
      ])

      let continued = 0
      const result = committedOf(
        await run(
          commit(
            baseContext(root, {
              startingCommitOid: startingOid,
              publicationTitle: "already committed",
              publicationBody: "Seeded.\n\nCloses #91",
            }),
          ),
          stubOpencode({
            continueTurn: () => {
              continued += 1
              return Effect.succeed({
                sessionId: "ses",
                assistantText:
                  "Investigated without edits.\nREADY_FOR_AGENT_RESULT: NO_CHANGES",
              })
            },
          }),
        ),
      )

      expect(result.completion).toBe("native")
      expect(result.publicationTitle).toBe("already committed")
      expect(continued).toBe(0)
    }))

  it("keeps Repair Fallback when a native hook fails with real staged files", () =>
    withTempRepo(async (root, startingOid) => {
      await writeFile(join(root, "feature.ts"), "export const n = 1\n")
      const hooks = join(root, ".git", "hooks")
      await mkdir(hooks, { recursive: true })
      await writeFile(
        join(hooks, "commit-msg"),
        `#!/bin/sh
echo hook failed >&2
exit 1
`,
      )
      await chmod(join(hooks, "commit-msg"), 0o755)

      const prompts: string[] = []
      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            publicationTitle: "feat: always fail",
            publicationBody: "Will not commit.\n\nCloses #91",
          }),
        ).pipe(Effect.flip),
        stubOpencode({
          continueTurn: (input) => {
            prompts.push(input.prompt)
            return Effect.succeed({
              sessionId: input.sessionId,
              assistantText: "",
            })
          },
        }),
      )

      expect(error).toBeInstanceOf(CommitPostconditionError)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("Bounded native failure diagnostics")
      expect(prompts[0]).not.toBe(buildNoChangeConfirmationPrompt())
    }))

  it("requires Session context to confirm nothing to publish", () =>
    withTempRepo(async (root, startingOid) => {
      const error = await run(
        commit(
          baseContext(root, {
            startingCommitOid: startingOid,
            sessionId: null,
          }),
        ).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(CommitSessionContextMissingError)
    }))
})
